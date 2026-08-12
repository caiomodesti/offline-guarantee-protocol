use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    program::{invoke, invoke_signed},
    system_instruction, system_program,
};
use solana_instructions_sysvar::{load_current_index_checked, load_instruction_at_checked};
use solana_sdk_ids::ed25519_program;
use solana_sha256_hasher::hashv;

use crate::{errors::OgpError, state::OfflineSession, state::ProtocolConfig};

pub const PAYMENT_CREDENTIAL_PAYLOAD_LEN: usize = 410;
pub const PAYMENT_STATE_LEN: usize = 234;
pub const GENESIS_STATE_LEN: usize = 210;
pub const ED25519_OFFSETS_LEN: usize = 16;
pub const ANCHOR_DISCRIMINATOR_LEN: usize = 8;
pub const BORSH_VEC_PREFIX_LEN: usize = 4;
pub const CREDENTIAL_PAYLOAD_IX_OFFSET: u16 =
    (ANCHOR_DISCRIMINATOR_LEN + BORSH_VEC_PREFIX_LEN) as u16;
pub const PAYER_DEVICE_KEY_PAYLOAD_OFFSET: u16 = 178;
pub const PAYER_SIGNATURE_IX_OFFSET: u16 =
    CREDENTIAL_PAYLOAD_IX_OFFSET + PAYMENT_CREDENTIAL_PAYLOAD_LEN as u16;

const PROTOCOL_NAME: [u8; 8] = *b"OGP\0\0\0\0\0";
const PROTOCOL_VERSION: u16 = 1;
const SCHEMA_VERSION: u16 = 1;
const PAYMENT_STATE_OBJECT_TYPE: u8 = 4;
const PAYMENT_CREDENTIAL_OBJECT_TYPE: u8 = 5;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct PaymentCredentialPayloadV1 {
    pub protocol_name: [u8; 8],
    pub protocol_version: u16,
    pub schema_version: u16,
    pub object_type: u8,
    pub network_id: u8,
    pub cluster_genesis_hash: [u8; 32],
    pub program_id: [u8; 32],
    pub domain_session_id: [u8; 32],
    pub payload_session_id: [u8; 32],
    pub sequence: u32,
    pub payer: [u8; 32],
    pub payer_device_key: [u8; 32],
    pub merchant: [u8; 32],
    pub merchant_device_key: [u8; 32],
    pub amount: u64,
    pub previous_state_hash: [u8; 32],
    pub new_state_hash: [u8; 32],
    pub previous_remaining: u64,
    pub new_remaining: u64,
    pub merchant_challenge: [u8; 32],
    pub created_at: i64,
    pub session_expires_at: i64,
}

#[derive(AnchorSerialize)]
struct PaymentStateV1 {
    protocol_name: [u8; 8],
    protocol_version: u16,
    schema_version: u16,
    object_type: u8,
    network_id: u8,
    cluster_genesis_hash: [u8; 32],
    program_id: [u8; 32],
    domain_session_id: [u8; 32],
    previous_state_hash: [u8; 32],
    sequence: u32,
    merchant: [u8; 32],
    amount: u64,
    merchant_challenge: [u8; 32],
    previous_remaining: u64,
    new_remaining: u64,
}

#[derive(AnchorSerialize)]
struct GenesisStateV1 {
    protocol_name: [u8; 8],
    protocol_version: u16,
    schema_version: u16,
    object_type: u8,
    network_id: u8,
    cluster_genesis_hash: [u8; 32],
    program_id: [u8; 32],
    domain_session_id: [u8; 32],
    owner: [u8; 32],
    device_public_key: [u8; 32],
    branch_spending_limit: u64,
    max_branch_depth: u32,
    initial_remaining: u64,
    issued_at: i64,
    expires_at: i64,
}

pub struct ValidatedClaim {
    pub payload: PaymentCredentialPayloadV1,
    pub credential_hash: [u8; 32],
}

pub fn validate_network_domain(network_id: u8, cluster_genesis_hash: &[u8; 32]) -> Result<()> {
    require!(network_id <= 2, OgpError::InvalidNetworkDomain);
    require!(
        cluster_genesis_hash.iter().any(|byte| *byte != 0),
        OgpError::InvalidNetworkDomain
    );
    Ok(())
}

pub fn derive_genesis_state_hash(
    config: &ProtocolConfig,
    session_id: [u8; 32],
    owner: Pubkey,
    device_public_key: Pubkey,
    branch_spending_limit: u64,
    issued_at: i64,
    expires_at: i64,
) -> Result<[u8; 32]> {
    let genesis = GenesisStateV1 {
        protocol_name: PROTOCOL_NAME,
        protocol_version: PROTOCOL_VERSION,
        schema_version: SCHEMA_VERSION,
        object_type: 3,
        network_id: config.network_id,
        cluster_genesis_hash: config.cluster_genesis_hash,
        program_id: crate::ID.to_bytes(),
        domain_session_id: session_id,
        owner: owner.to_bytes(),
        device_public_key: device_public_key.to_bytes(),
        branch_spending_limit,
        max_branch_depth: config.max_branch_depth,
        initial_remaining: branch_spending_limit,
        issued_at,
        expires_at,
    };
    let mut bytes = Vec::with_capacity(GENESIS_STATE_LEN);
    genesis
        .serialize(&mut bytes)
        .map_err(|_| error!(OgpError::InvalidSessionMaterial))?;
    require!(
        bytes.len() == GENESIS_STATE_LEN,
        OgpError::InvalidSessionMaterial
    );
    Ok(hashv(&[&bytes]).to_bytes())
}

pub fn validate_ed25519_instruction(
    instructions_sysvar: &AccountInfo,
    credential_payload: &[u8],
    payer_signature: &[u8; 64],
) -> Result<()> {
    require!(
        credential_payload.len() == PAYMENT_CREDENTIAL_PAYLOAD_LEN,
        OgpError::InvalidCredentialPayload
    );
    let current_index = load_current_index_checked(instructions_sysvar)?;
    require!(current_index > 0, OgpError::InvalidEd25519Verification);
    let current = load_instruction_at_checked(current_index as usize, instructions_sysvar)?;
    let verifier = load_instruction_at_checked((current_index - 1) as usize, instructions_sysvar)?;

    require_keys_eq!(
        current.program_id,
        crate::ID,
        OgpError::InvalidEd25519Verification
    );
    require_keys_eq!(
        verifier.program_id,
        ed25519_program::ID,
        OgpError::InvalidEd25519Verification
    );
    require!(
        verifier.accounts.is_empty(),
        OgpError::InvalidEd25519Verification
    );
    require!(
        verifier.data.len() == ED25519_OFFSETS_LEN
            && verifier.data[0] == 1
            && verifier.data[1] == 0,
        OgpError::InvalidEd25519Verification
    );

    let read_u16 = |start: usize| -> u16 {
        u16::from_le_bytes([verifier.data[start], verifier.data[start + 1]])
    };
    let expected_index = current_index;
    require!(
        read_u16(2) == PAYER_SIGNATURE_IX_OFFSET
            && read_u16(4) == expected_index
            && read_u16(6) == CREDENTIAL_PAYLOAD_IX_OFFSET + PAYER_DEVICE_KEY_PAYLOAD_OFFSET
            && read_u16(8) == expected_index
            && read_u16(10) == CREDENTIAL_PAYLOAD_IX_OFFSET
            && read_u16(12) == PAYMENT_CREDENTIAL_PAYLOAD_LEN as u16
            && read_u16(14) == expected_index,
        OgpError::InvalidEd25519Verification
    );

    let expected_len = PAYER_SIGNATURE_IX_OFFSET as usize + payer_signature.len();
    require!(
        current.data.len() == expected_len,
        OgpError::InvalidEd25519Verification
    );
    let message_start = CREDENTIAL_PAYLOAD_IX_OFFSET as usize;
    let message_end = message_start + PAYMENT_CREDENTIAL_PAYLOAD_LEN;
    require!(
        current.data[message_start..message_end] == *credential_payload
            && current.data[message_end..expected_len] == payer_signature[..],
        OgpError::InvalidEd25519Verification
    );
    Ok(())
}

pub fn validate_claim_payload(
    config: &ProtocolConfig,
    session: &OfflineSession,
    merchant: Pubkey,
    now: i64,
    credential_payload: &[u8],
    payer_signature: &[u8; 64],
) -> Result<ValidatedClaim> {
    require!(
        now <= session.claim_submission_deadline,
        OgpError::ClaimSubmissionClosed
    );
    let payload = PaymentCredentialPayloadV1::try_from_slice(credential_payload)
        .map_err(|_| error!(OgpError::InvalidCredentialPayload))?;
    require!(
        payload.protocol_name == PROTOCOL_NAME
            && payload.protocol_version == PROTOCOL_VERSION
            && payload.schema_version == SCHEMA_VERSION
            && payload.object_type == PAYMENT_CREDENTIAL_OBJECT_TYPE
            && payload.network_id == config.network_id
            && payload.cluster_genesis_hash == config.cluster_genesis_hash
            && payload.program_id == crate::ID.to_bytes()
            && payload.domain_session_id == session.session_id
            && payload.payload_session_id == session.session_id,
        OgpError::InvalidCredentialPayload
    );
    require!(
        Pubkey::new_from_array(payload.payer) == session.owner
            && Pubkey::new_from_array(payload.payer_device_key) == session.device_public_key
            && Pubkey::new_from_array(payload.merchant) == merchant
            && merchant != session.owner,
        OgpError::ClaimBindingMismatch
    );
    require!(payload.amount > 0, OgpError::InvalidAmount);
    require!(
        payload.sequence > 0 && payload.sequence <= session.max_branch_depth,
        OgpError::BranchDepthExceeded
    );
    require!(
        payload.created_at >= session.issued_at
            && payload.created_at <= session.expires_at
            && payload.session_expires_at == session.expires_at,
        OgpError::InvalidCredentialPayload
    );
    require!(
        payload.merchant_challenge.iter().any(|byte| *byte != 0),
        OgpError::InvalidMerchantChallenge
    );
    require!(
        payload.previous_remaining <= session.branch_spending_limit
            && payload.amount <= payload.previous_remaining
            && payload
                .previous_remaining
                .checked_sub(payload.amount)
                .ok_or(OgpError::ArithmeticOverflow)?
                == payload.new_remaining,
        OgpError::InvalidStateTransition
    );

    let state = PaymentStateV1 {
        protocol_name: PROTOCOL_NAME,
        protocol_version: PROTOCOL_VERSION,
        schema_version: SCHEMA_VERSION,
        object_type: PAYMENT_STATE_OBJECT_TYPE,
        network_id: config.network_id,
        cluster_genesis_hash: config.cluster_genesis_hash,
        program_id: crate::ID.to_bytes(),
        domain_session_id: session.session_id,
        previous_state_hash: payload.previous_state_hash,
        sequence: payload.sequence,
        merchant: payload.merchant,
        amount: payload.amount,
        merchant_challenge: payload.merchant_challenge,
        previous_remaining: payload.previous_remaining,
        new_remaining: payload.new_remaining,
    };
    let mut state_bytes = Vec::with_capacity(PAYMENT_STATE_LEN);
    state
        .serialize(&mut state_bytes)
        .map_err(|_| error!(OgpError::InvalidCredentialPayload))?;
    require!(
        state_bytes.len() == PAYMENT_STATE_LEN,
        OgpError::InvalidCredentialPayload
    );
    require!(
        hashv(&[&state_bytes]).to_bytes() == payload.new_state_hash,
        OgpError::InvalidStateTransition
    );

    Ok(ValidatedClaim {
        payload,
        credential_hash: hashv(&[credential_payload, payer_signature]).to_bytes(),
    })
}

pub fn create_program_pda<'info>(
    payer: &AccountInfo<'info>,
    destination: &AccountInfo<'info>,
    system_program_info: &AccountInfo<'info>,
    space: usize,
    signer_seeds: &[&[u8]],
) -> Result<()> {
    require_keys_eq!(
        *destination.owner,
        system_program::ID,
        OgpError::InvalidClaimAccount
    );
    require!(destination.data_is_empty(), OgpError::InvalidClaimAccount);
    let required_lamports = Rent::get()?.minimum_balance(space).max(1);
    if destination.lamports() == 0 {
        invoke_signed(
            &system_instruction::create_account(
                payer.key,
                destination.key,
                required_lamports,
                space as u64,
                &crate::ID,
            ),
            &[
                payer.clone(),
                destination.clone(),
                system_program_info.clone(),
            ],
            &[signer_seeds],
        )?;
    } else {
        let missing = required_lamports.saturating_sub(destination.lamports());
        if missing > 0 {
            invoke(
                &system_instruction::transfer(payer.key, destination.key, missing),
                &[
                    payer.clone(),
                    destination.clone(),
                    system_program_info.clone(),
                ],
            )?;
        }
        invoke_signed(
            &system_instruction::allocate(destination.key, space as u64),
            &[destination.clone(), system_program_info.clone()],
            &[signer_seeds],
        )?;
        invoke_signed(
            &system_instruction::assign(destination.key, &crate::ID),
            &[destination.clone(), system_program_info.clone()],
            &[signer_seeds],
        )?;
    }
    Ok(())
}

pub fn write_program_account<T: AccountSerialize>(account: &AccountInfo, value: &T) -> Result<()> {
    let mut data = account.try_borrow_mut_data()?;
    value.try_serialize(&mut &mut data[..])?;
    Ok(())
}

pub fn read_program_account<T: AccountDeserialize>(account: &AccountInfo) -> Result<T> {
    require_keys_eq!(*account.owner, crate::ID, OgpError::InvalidClaimAccount);
    T::try_deserialize(&mut &account.try_borrow_data()?[..])
        .map_err(|_| error!(OgpError::InvalidClaimAccount))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_lengths_and_instruction_offsets_are_frozen() {
        let payload = PaymentCredentialPayloadV1 {
            protocol_name: PROTOCOL_NAME,
            protocol_version: 1,
            schema_version: 1,
            object_type: 5,
            network_id: 0,
            cluster_genesis_hash: [1; 32],
            program_id: [2; 32],
            domain_session_id: [3; 32],
            payload_session_id: [3; 32],
            sequence: 1,
            payer: [4; 32],
            payer_device_key: [5; 32],
            merchant: [6; 32],
            merchant_device_key: [7; 32],
            amount: 1,
            previous_state_hash: [8; 32],
            new_state_hash: [9; 32],
            previous_remaining: 2,
            new_remaining: 1,
            merchant_challenge: [10; 32],
            created_at: 1,
            session_expires_at: 2,
        };
        let mut bytes = Vec::new();
        payload.serialize(&mut bytes).unwrap();
        assert_eq!(bytes.len(), PAYMENT_CREDENTIAL_PAYLOAD_LEN);
        assert_eq!(
            &bytes[PAYER_DEVICE_KEY_PAYLOAD_OFFSET as usize
                ..PAYER_DEVICE_KEY_PAYLOAD_OFFSET as usize + 32],
            &[5; 32]
        );
        assert_eq!(CREDENTIAL_PAYLOAD_IX_OFFSET, 12);
        assert_eq!(PAYER_SIGNATURE_IX_OFFSET, 422);
    }
}
