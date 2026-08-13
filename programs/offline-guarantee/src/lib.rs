#![allow(unexpected_cfgs)]

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, TransferChecked};

pub mod claims;
pub mod errors;
pub mod math;
pub mod state;

use claims::{
    create_program_pda, derive_genesis_state_hash, read_program_account, validate_claim_payload,
    validate_ed25519_instruction, validate_network_domain, write_program_account,
};
use errors::OgpError;
use math::{
    checked_base_allocation, checked_deposit, checked_reservation, claim_submission_deadline,
    coverage_amount, validate_session_economics, validate_session_window,
};
use solana_sha256_hasher::hashv;
use state::*;

declare_id!("5Sa9K4yLThfeg9UN9sMsiQwNA2RKPbeDywgJvJ1rkgEm");

#[program]
pub mod offline_guarantee {
    use super::*;

    pub fn initialize_protocol(
        ctx: Context<InitializeProtocol>,
        emergency_authority: Pubkey,
        identity_authority: Pubkey,
        certificate_issuer: Pubkey,
        network_id: u8,
        cluster_genesis_hash: [u8; 32],
    ) -> Result<()> {
        validate_authorities(
            ctx.accounts.admin.key(),
            emergency_authority,
            identity_authority,
            certificate_issuer,
        )?;
        validate_network_domain(network_id, &cluster_genesis_hash)?;
        let config = &mut ctx.accounts.config;
        config.admin = ctx.accounts.admin.key();
        config.emergency_authority = emergency_authority;
        config.identity_authority = identity_authority;
        config.certificate_issuer = certificate_issuer;
        config.settlement_mint = ctx.accounts.settlement_mint.key();
        config.network_id = network_id;
        config.cluster_genesis_hash = cluster_genesis_hash;
        config.minimum_collateral_ratio_bps = MINIMUM_COLLATERAL_RATIO_BPS;
        config.max_session_duration_seconds = MAX_SESSION_DURATION_SECONDS;
        config.claim_grace_period_seconds = CLAIM_GRACE_PERIOD_SECONDS;
        config.max_branch_depth = MAX_BRANCH_DEPTH;
        config.paused = false;
        config.bump = ctx.bumps.config;
        emit!(ProtocolInitialized {
            config: config.key(),
            admin: config.admin,
            emergency_authority,
            identity_authority,
            certificate_issuer,
            settlement_mint: config.settlement_mint,
            network_id,
            cluster_genesis_hash,
            minimum_collateral_ratio_bps: MINIMUM_COLLATERAL_RATIO_BPS,
        });
        Ok(())
    }

    pub fn set_paused(ctx: Context<SetPaused>, paused: bool) -> Result<()> {
        let authority = ctx.accounts.authority.key();
        let config = &mut ctx.accounts.config;
        let permitted =
            can_change_pause(config.admin, config.emergency_authority, authority, paused);
        require!(permitted, OgpError::Unauthorized);
        config.paused = paused;
        emit!(ProtocolPauseChanged {
            config: config.key(),
            authority,
            paused
        });
        Ok(())
    }

    pub fn create_user_profile(
        ctx: Context<CreateUserProfile>,
        identity_attestation_hash: [u8; 32],
        identity_expires_at: i64,
    ) -> Result<()> {
        require_not_paused(&ctx.accounts.config)?;
        require!(
            identity_attestation_hash.iter().any(|byte| *byte != 0),
            OgpError::InvalidIdentityAttestation
        );
        let now = Clock::get()?.unix_timestamp;
        require!(identity_expires_at > now, OgpError::IdentityExpired);
        let profile = &mut ctx.accounts.profile;
        profile.owner = ctx.accounts.owner.key();
        profile.identity_attestation_hash = identity_attestation_hash;
        profile.identity_issuer = ctx.accounts.identity_authority.key();
        profile.risk_tier = 1;
        profile.offline_access_enabled = true;
        profile.successful_sessions = 0;
        profile.conflict_count = 0;
        profile.revoked_at = 0;
        profile.identity_expires_at = identity_expires_at;
        profile.active_session = Pubkey::default();
        profile.bump = ctx.bumps.profile;
        emit!(UserProfileCreated {
            profile: profile.key(),
            owner: profile.owner,
            identity_issuer: profile.identity_issuer,
            identity_attestation_hash,
            identity_expires_at,
        });
        Ok(())
    }

    pub fn create_vault(ctx: Context<CreateVault>) -> Result<()> {
        require_not_paused(&ctx.accounts.config)?;
        let vault = &mut ctx.accounts.vault;
        vault.owner = ctx.accounts.owner.key();
        vault.token_mint = ctx.accounts.settlement_mint.key();
        vault.token_account = ctx.accounts.vault_token.key();
        vault.deposited_amount = 0;
        vault.reserved_amount = 0;
        vault.settled_from_collateral = 0;
        vault.bump = ctx.bumps.vault;
        vault.token_account_bump = ctx.bumps.vault_token;
        emit!(CollateralVaultCreated {
            vault: vault.key(),
            owner: vault.owner,
            token_mint: vault.token_mint,
            token_account: vault.token_account,
        });
        Ok(())
    }

    pub fn deposit_collateral(ctx: Context<DepositCollateral>, amount: u64) -> Result<()> {
        require_not_paused(&ctx.accounts.config)?;
        require!(amount > 0, OgpError::InvalidAmount);
        let transfer = TransferChecked {
            from: ctx.accounts.owner_token.to_account_info(),
            mint: ctx.accounts.settlement_mint.to_account_info(),
            to: ctx.accounts.vault_token.to_account_info(),
            authority: ctx.accounts.owner.to_account_info(),
        };
        token::transfer_checked(
            CpiContext::new(ctx.accounts.token_program.key(), transfer),
            amount,
            ctx.accounts.settlement_mint.decimals,
        )?;
        ctx.accounts.vault_token.reload()?;
        let new_deposited = checked_deposit(
            ctx.accounts.vault.deposited_amount,
            amount,
            ctx.accounts.vault_token.amount,
        )?;
        ctx.accounts.vault.deposited_amount = new_deposited;
        emit!(CollateralDeposited {
            vault: ctx.accounts.vault.key(),
            owner: ctx.accounts.owner.key(),
            amount,
            deposited_amount: new_deposited,
            actual_token_balance: ctx.accounts.vault_token.amount,
        });
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    pub fn create_offline_session(
        ctx: Context<CreateOfflineSession>,
        session_id: [u8; 32],
        device_public_key: Pubkey,
        collateral_locked: u64,
        branch_spending_limit: u64,
        expires_at: i64,
    ) -> Result<()> {
        require_not_paused(&ctx.accounts.config)?;
        require!(
            ctx.accounts.profile.offline_access_enabled,
            OgpError::OfflineAccessDisabled
        );
        require!(
            ctx.accounts.profile.active_session == Pubkey::default(),
            OgpError::ActiveSessionExists
        );
        let now = Clock::get()?.unix_timestamp;
        require!(
            ctx.accounts.profile.identity_expires_at > now,
            OgpError::IdentityExpired
        );
        validate_session_material(ctx.accounts.owner.key(), device_public_key, &session_id)?;
        validate_session_economics(
            collateral_locked,
            branch_spending_limit,
            ctx.accounts.config.minimum_collateral_ratio_bps,
        )?;
        validate_session_window(
            now,
            expires_at,
            ctx.accounts.config.max_session_duration_seconds,
        )?;
        require!(
            ctx.accounts.profile.identity_expires_at >= expires_at,
            OgpError::IdentityExpired
        );
        let deadline =
            claim_submission_deadline(expires_at, ctx.accounts.config.claim_grace_period_seconds)?;
        let genesis_state_hash = derive_genesis_state_hash(
            &ctx.accounts.config,
            session_id,
            ctx.accounts.owner.key(),
            device_public_key,
            branch_spending_limit,
            now,
            expires_at,
        )?;
        let new_reserved = checked_reservation(
            ctx.accounts.vault.deposited_amount,
            ctx.accounts.vault.reserved_amount,
            ctx.accounts.vault_token.amount,
            collateral_locked,
        )?;
        ctx.accounts.vault.reserved_amount = new_reserved;

        let session = &mut ctx.accounts.session;
        session.session_id = session_id;
        session.owner = ctx.accounts.owner.key();
        session.device_public_key = device_public_key;
        session.collateral_vault = ctx.accounts.vault.key();
        session.collateral_locked = collateral_locked;
        session.branch_spending_limit = branch_spending_limit;
        session.collateral_coverage_cap = collateral_locked;
        session.max_branch_depth = ctx.accounts.config.max_branch_depth;
        session.issued_at = now;
        session.expires_at = expires_at;
        session.claim_submission_deadline = deadline;
        session.status = SessionStatus::Active;
        session.authenticated_fork = false;
        session.coverage_status = CoverageStatus::Uncalculated;
        session.genesis_state_hash = genesis_state_hash;
        session.device_authorization_hash = [0; 32];
        session.identity_attestation_hash = ctx.accounts.profile.identity_attestation_hash;
        session.settled_amount = 0;
        session.aggregate_offline_exposure = 0;
        session.unique_edge_count = 0;
        session.conflicting_claim_count = 0;
        session.resolution_hash = [0; 32];
        session.bump = ctx.bumps.session;
        session.frozen_edge_count = 0;
        session.frozen_exposure = 0;
        session.submitted_claim_count = 0;
        session.classified_edge_count = 0;
        session.classified_exposure = 0;
        session.base_allocation_total = 0;
        session.allocated_edge_count = 0;
        session.allocated_total = 0;
        session.scanned_claim_count = 0;
        session.settled_edge_count = 0;
        session.claim_head = Pubkey::default();
        session.claim_tail = Pubkey::default();
        session.next_allocation_claim = Pubkey::default();
        session.classification_complete = false;
        session.allocation_complete = false;
        ctx.accounts.profile.active_session = session.key();
        emit!(OfflineSessionCreated {
            session: session.key(),
            session_id,
            owner: session.owner,
            device_public_key,
            collateral_vault: session.collateral_vault,
            collateral_locked,
            branch_spending_limit,
            collateral_coverage_cap: collateral_locked,
            issued_at: now,
            expires_at,
            claim_submission_deadline: deadline,
        });
        Ok(())
    }

    pub fn register_device_authorization(
        ctx: Context<RegisterDeviceAuthorization>,
        device_authorization_hash: [u8; 32],
    ) -> Result<()> {
        require_not_paused(&ctx.accounts.config)?;
        require!(
            device_authorization_hash.iter().any(|byte| *byte != 0),
            OgpError::InvalidSessionMaterial
        );
        require!(
            ctx.accounts.session.device_authorization_hash == [0; 32],
            OgpError::InvalidSessionMaterial
        );
        ctx.accounts.session.device_authorization_hash = device_authorization_hash;
        emit!(DeviceAuthorizationRegistered {
            session: ctx.accounts.session.key(),
            owner: ctx.accounts.owner.key(),
            device_authorization_hash,
        });
        Ok(())
    }

    pub fn submit_claim(
        ctx: Context<SubmitClaim>,
        credential_payload: Vec<u8>,
        payer_signature: [u8; 64],
    ) -> Result<()> {
        require_not_paused(&ctx.accounts.config)?;
        require!(
            matches!(
                ctx.accounts.session.status,
                SessionStatus::Active | SessionStatus::ClaimWindow | SessionStatus::Conflicted
            ),
            OgpError::InvalidSessionStatus
        );
        require!(
            ctx.accounts
                .session
                .device_authorization_hash
                .iter()
                .any(|byte| *byte != 0),
            OgpError::InvalidSessionMaterial
        );
        validate_ed25519_instruction(
            &ctx.accounts.instructions.to_account_info(),
            &credential_payload,
            &payer_signature,
        )?;
        let clock = Clock::get()?;
        let validated = validate_claim_payload(
            &ctx.accounts.config,
            &ctx.accounts.session,
            ctx.accounts.merchant.key(),
            clock.unix_timestamp,
            &credential_payload,
            &payer_signature,
        )?;

        let session_key = ctx.accounts.session.key();
        let payload = validated.payload;
        let (expected_claim, claim_bump) = Pubkey::find_program_address(
            &[b"claim", session_key.as_ref(), &validated.credential_hash],
            &crate::ID,
        );
        require_keys_eq!(
            expected_claim,
            ctx.accounts.claim.key(),
            OgpError::InvalidClaimAccount
        );
        let sequence_bytes = payload.sequence.to_le_bytes();
        let (expected_edge, edge_bump) = Pubkey::find_program_address(
            &[
                b"edge",
                session_key.as_ref(),
                &payload.previous_state_hash,
                &sequence_bytes,
                &payload.new_state_hash,
            ],
            &crate::ID,
        );
        require_keys_eq!(
            expected_edge,
            ctx.accounts.state_edge.key(),
            OgpError::InvalidClaimAccount
        );
        let (expected_fork_record, fork_bump) = Pubkey::find_program_address(
            &[
                b"fork",
                session_key.as_ref(),
                &payload.previous_state_hash,
                &sequence_bytes,
            ],
            &crate::ID,
        );
        require_keys_eq!(
            expected_fork_record,
            ctx.accounts.fork_record.key(),
            OgpError::InvalidForkRecord
        );

        if ctx.accounts.claim.owner == &crate::ID {
            let existing: Claim = read_program_account(&ctx.accounts.claim)?;
            require!(
                existing.credential_hash != validated.credential_hash,
                OgpError::DuplicateCredential
            );
            return err!(OgpError::InvalidClaimAccount);
        }

        let existing_edge = if ctx.accounts.state_edge.owner == &crate::ID {
            let edge: StateEdgeRecord = read_program_account(&ctx.accounts.state_edge)?;
            require!(
                edge.session == session_key
                    && edge.previous_state_hash == payload.previous_state_hash
                    && edge.sequence == payload.sequence
                    && edge.new_state_hash == payload.new_state_hash
                    && edge.merchant == ctx.accounts.merchant.key()
                    && edge.amount == payload.amount
                    && edge.previous_remaining == payload.previous_remaining
                    && edge.new_remaining == payload.new_remaining,
                OgpError::InvalidClaimAccount
            );
            Some(edge)
        } else {
            None
        };

        let existing_representative = if let Some(edge) = existing_edge.as_ref() {
            let (expected_representative, _) = Pubkey::find_program_address(
                &[
                    b"claim",
                    session_key.as_ref(),
                    &edge.representative_credential_hash,
                ],
                &crate::ID,
            );
            require_keys_eq!(
                expected_representative,
                ctx.accounts.representative_claim.key(),
                OgpError::InvalidClaimAccount
            );
            let representative: Claim = read_program_account(&ctx.accounts.representative_claim)?;
            require!(
                representative.session == session_key
                    && representative.credential_hash == edge.representative_credential_hash
                    && representative.status == ClaimStatus::Submitted
                    && representative.rejection_reason == ClaimRejectionReason::None,
                OgpError::InvalidClaimAccount
            );
            Some(representative)
        } else {
            require_keys_eq!(
                ctx.accounts.claim.key(),
                ctx.accounts.representative_claim.key(),
                OgpError::InvalidClaimAccount
            );
            None
        };

        if existing_edge.is_none() {
            validate_reachable_parent(
                session_key,
                &ctx.accounts.session,
                &ctx.accounts.parent_edge.to_account_info(),
                &payload,
            )?;
        }

        let claim_bump_seed = [claim_bump];
        let claim_seeds: &[&[u8]] = &[
            b"claim",
            session_key.as_ref(),
            &validated.credential_hash,
            &claim_bump_seed,
        ];
        create_program_pda(
            &ctx.accounts.relayer.to_account_info(),
            &ctx.accounts.claim.to_account_info(),
            &ctx.accounts.system_program.to_account_info(),
            Claim::SPACE,
            claim_seeds,
        )?;

        let is_unique_edge = existing_edge.is_none();
        let is_economic_representative = match existing_edge.as_ref() {
            Some(edge) => validated.credential_hash < edge.representative_credential_hash,
            None => true,
        };
        let rejection_reason = if is_economic_representative {
            ClaimRejectionReason::None
        } else {
            ClaimRejectionReason::DuplicateStateEdge
        };
        let claim = Claim {
            credential_hash: validated.credential_hash,
            session: session_key,
            merchant: ctx.accounts.merchant.key(),
            amount: payload.amount,
            sequence: payload.sequence,
            previous_state_hash: payload.previous_state_hash,
            new_state_hash: payload.new_state_hash,
            submitted_slot: clock.slot,
            status: if is_economic_representative {
                ClaimStatus::Submitted
            } else {
                ClaimStatus::Rejected
            },
            rejection_reason,
            allocated_amount: 0,
            settled_amount: 0,
            bump: claim_bump,
            previous_claim: Pubkey::default(),
            next_claim: Pubkey::default(),
            allocation_processed: false,
        };
        write_program_account(&ctx.accounts.claim, &claim)?;

        if let Some(mut edge) = existing_edge {
            edge.wrapper_count = edge
                .wrapper_count
                .checked_add(1)
                .ok_or(OgpError::ArithmeticOverflow)?;
            if is_economic_representative {
                let mut previous_representative =
                    existing_representative.ok_or(OgpError::InvalidClaimAccount)?;
                previous_representative.status = ClaimStatus::Rejected;
                previous_representative.rejection_reason = ClaimRejectionReason::DuplicateStateEdge;
                write_program_account(
                    &ctx.accounts.representative_claim,
                    &previous_representative,
                )?;
                edge.representative_credential_hash = validated.credential_hash;
            }
            write_program_account(&ctx.accounts.state_edge, &edge)?;
        } else {
            let edge_bump_seed = [edge_bump];
            let edge_seeds: &[&[u8]] = &[
                b"edge",
                session_key.as_ref(),
                &payload.previous_state_hash,
                &sequence_bytes,
                &payload.new_state_hash,
                &edge_bump_seed,
            ];
            create_program_pda(
                &ctx.accounts.relayer.to_account_info(),
                &ctx.accounts.state_edge.to_account_info(),
                &ctx.accounts.system_program.to_account_info(),
                StateEdgeRecord::SPACE,
                edge_seeds,
            )?;
            let edge = StateEdgeRecord {
                session: session_key,
                previous_state_hash: payload.previous_state_hash,
                sequence: payload.sequence,
                new_state_hash: payload.new_state_hash,
                merchant: ctx.accounts.merchant.key(),
                amount: payload.amount,
                previous_remaining: payload.previous_remaining,
                new_remaining: payload.new_remaining,
                representative_credential_hash: validated.credential_hash,
                wrapper_count: 1,
                submitted_slot: clock.slot,
                allocated_amount: 0,
                settled_amount: 0,
                bump: edge_bump,
                classified: false,
                conflicting: false,
                allocation_finalized: false,
            };
            write_program_account(&ctx.accounts.state_edge, &edge)?;
            register_fork_child(
                &mut ctx.accounts.session,
                &mut ctx.accounts.profile,
                &ctx.accounts.relayer.to_account_info(),
                &ctx.accounts.fork_record.to_account_info(),
                &ctx.accounts.system_program.to_account_info(),
                payload.previous_state_hash,
                payload.sequence,
                payload.new_state_hash,
                fork_bump,
                clock.unix_timestamp,
            )?;
            ctx.accounts.session.aggregate_offline_exposure = ctx
                .accounts
                .session
                .aggregate_offline_exposure
                .checked_add(payload.amount)
                .ok_or(OgpError::ArithmeticOverflow)?;
            ctx.accounts.session.unique_edge_count = ctx
                .accounts
                .session
                .unique_edge_count
                .checked_add(1)
                .ok_or(OgpError::ArithmeticOverflow)?;
        }
        insert_claim_in_order(
            &mut ctx.accounts.session,
            &ctx.accounts.claim.to_account_info(),
            &ctx.accounts.predecessor_claim.to_account_info(),
            &ctx.accounts.successor_claim.to_account_info(),
        )?;
        if clock.unix_timestamp > ctx.accounts.session.expires_at
            && ctx.accounts.session.status == SessionStatus::Active
        {
            ctx.accounts.session.status = SessionStatus::ClaimWindow;
        }

        emit!(ClaimSubmitted {
            claim: ctx.accounts.claim.key(),
            state_edge: ctx.accounts.state_edge.key(),
            session: session_key,
            credential_hash: validated.credential_hash,
            merchant: ctx.accounts.merchant.key(),
            amount: payload.amount,
            sequence: payload.sequence,
            is_unique_edge,
            is_economic_representative,
            rejection_reason,
            aggregate_offline_exposure: ctx.accounts.session.aggregate_offline_exposure,
            unique_edge_count: ctx.accounts.session.unique_edge_count,
            submitted_slot: clock.slot,
        });
        Ok(())
    }

    pub fn begin_finalization(ctx: Context<BeginFinalization>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        require!(
            now > ctx.accounts.session.claim_submission_deadline,
            OgpError::ClaimSubmissionClosed
        );
        require!(
            matches!(
                ctx.accounts.session.status,
                SessionStatus::Active | SessionStatus::ClaimWindow | SessionStatus::Conflicted
            ),
            OgpError::InvalidSessionStatus
        );
        ctx.accounts.session.frozen_edge_count = ctx.accounts.session.unique_edge_count;
        ctx.accounts.session.frozen_exposure = ctx.accounts.session.aggregate_offline_exposure;
        ctx.accounts.session.status = SessionStatus::Reconciling;
        ctx.accounts.session.next_allocation_claim = ctx.accounts.session.claim_head;
        ctx.accounts.session.resolution_hash = hashv(&[
            b"OGP:RESOLUTION:V1\0",
            crate::ID.as_ref(),
            ctx.accounts.session.key().as_ref(),
            &ctx.accounts.session.frozen_edge_count.to_le_bytes(),
            &ctx.accounts.session.frozen_exposure.to_le_bytes(),
            &ctx.accounts.session.collateral_coverage_cap.to_le_bytes(),
        ])
        .to_bytes();
        emit!(FinalizationStarted {
            session: ctx.accounts.session.key(),
            frozen_edge_count: ctx.accounts.session.frozen_edge_count,
            frozen_exposure: ctx.accounts.session.frozen_exposure,
            submitted_claim_count: ctx.accounts.session.submitted_claim_count,
        });
        if ctx.accounts.session.frozen_edge_count == 0 {
            require!(
                ctx.accounts.session.frozen_exposure == 0
                    && ctx.accounts.session.submitted_claim_count == 0,
                OgpError::InvalidFinalization
            );
            ctx.accounts.session.classification_complete = true;
            complete_allocation(&mut ctx.accounts.session, &mut ctx.accounts.vault)?;
        }
        Ok(())
    }

    pub fn classify_edge(ctx: Context<ClassifyEdge>) -> Result<()> {
        require!(
            ctx.accounts.session.status == SessionStatus::Reconciling
                && !ctx.accounts.session.classification_complete,
            OgpError::InvalidSessionStatus
        );
        require!(
            !ctx.accounts.state_edge.classified,
            OgpError::AlreadyProcessed
        );
        validate_edge_identity(
            ctx.accounts.session.key(),
            &ctx.accounts.state_edge,
            &ctx.accounts.fork_record,
        )?;

        let conflicting = if ctx.accounts.state_edge.sequence == 1 {
            require_keys_eq!(
                ctx.accounts.parent_edge.key(),
                ctx.accounts.session.key(),
                OgpError::InvalidClaimParent
            );
            require!(
                ctx.accounts.state_edge.previous_state_hash
                    == ctx.accounts.session.genesis_state_hash,
                OgpError::InvalidClaimParent
            );
            ctx.accounts.fork_record.branch_count >= 2
        } else {
            let parent: StateEdgeRecord = read_program_account(&ctx.accounts.parent_edge)?;
            require!(parent.classified, OgpError::InvalidFinalization);
            validate_parent_edge(
                ctx.accounts.session.key(),
                &ctx.accounts.state_edge,
                &ctx.accounts.parent_edge,
                &parent,
            )?;
            parent.conflicting || ctx.accounts.fork_record.branch_count >= 2
        };

        let base_allocation = checked_base_allocation(
            ctx.accounts.state_edge.amount,
            ctx.accounts.session.frozen_exposure,
            ctx.accounts.session.collateral_coverage_cap,
        )?;
        ctx.accounts.state_edge.classified = true;
        ctx.accounts.state_edge.conflicting = conflicting;
        ctx.accounts.state_edge.allocated_amount = base_allocation;
        ctx.accounts.session.classified_edge_count = ctx
            .accounts
            .session
            .classified_edge_count
            .checked_add(1)
            .ok_or(OgpError::ArithmeticOverflow)?;
        ctx.accounts.session.classified_exposure = ctx
            .accounts
            .session
            .classified_exposure
            .checked_add(ctx.accounts.state_edge.amount)
            .ok_or(OgpError::ArithmeticOverflow)?;
        ctx.accounts.session.base_allocation_total = ctx
            .accounts
            .session
            .base_allocation_total
            .checked_add(base_allocation)
            .ok_or(OgpError::ArithmeticOverflow)?;

        if ctx.accounts.session.classified_edge_count == ctx.accounts.session.frozen_edge_count {
            require!(
                ctx.accounts.session.classified_exposure == ctx.accounts.session.frozen_exposure,
                OgpError::InvalidFinalization
            );
            ctx.accounts.session.classification_complete = true;
        }
        emit!(EdgeClassified {
            session: ctx.accounts.session.key(),
            state_edge: ctx.accounts.state_edge.key(),
            representative_credential_hash: ctx.accounts.state_edge.representative_credential_hash,
            conflicting,
            base_allocation,
        });
        Ok(())
    }

    pub fn allocate_next_claim(ctx: Context<AllocateNextClaim>) -> Result<()> {
        require!(
            ctx.accounts.session.status == SessionStatus::Reconciling
                && ctx.accounts.session.classification_complete
                && !ctx.accounts.session.allocation_complete,
            OgpError::InvalidSessionStatus
        );
        require_keys_eq!(
            ctx.accounts.claim.key(),
            ctx.accounts.session.next_allocation_claim,
            OgpError::InvalidClaimOrder
        );
        require!(
            ctx.accounts.claim.session == ctx.accounts.session.key()
                && !ctx.accounts.claim.allocation_processed,
            OgpError::AlreadyProcessed
        );

        let is_representative = ctx.accounts.state_edge.representative_credential_hash
            == ctx.accounts.claim.credential_hash;
        require!(
            ctx.accounts.state_edge.merchant == ctx.accounts.claim.merchant
                && ctx.accounts.state_edge.amount == ctx.accounts.claim.amount
                && ctx.accounts.state_edge.sequence == ctx.accounts.claim.sequence
                && ctx.accounts.state_edge.previous_state_hash
                    == ctx.accounts.claim.previous_state_hash
                && ctx.accounts.state_edge.new_state_hash == ctx.accounts.claim.new_state_hash,
            OgpError::InvalidFinalization
        );
        if is_representative {
            require!(
                ctx.accounts.state_edge.classified && !ctx.accounts.state_edge.allocation_finalized,
                OgpError::InvalidFinalization
            );
            require!(
                ctx.accounts.claim.status == ClaimStatus::Submitted
                    && ctx.accounts.claim.rejection_reason == ClaimRejectionReason::None,
                OgpError::InvalidFinalization
            );
            let coverage = coverage_amount(
                ctx.accounts.session.frozen_exposure,
                ctx.accounts.session.collateral_coverage_cap,
            );
            let remainder = coverage
                .checked_sub(ctx.accounts.session.base_allocation_total)
                .ok_or(OgpError::ArithmeticOverflow)?;
            let dust = u64::from(ctx.accounts.session.allocated_edge_count < remainder);
            let allocation = ctx
                .accounts
                .state_edge
                .allocated_amount
                .checked_add(dust)
                .ok_or(OgpError::ArithmeticOverflow)?;
            require!(
                allocation <= ctx.accounts.state_edge.amount,
                OgpError::InvalidFinalization
            );
            ctx.accounts.state_edge.allocated_amount = allocation;
            ctx.accounts.state_edge.allocation_finalized = true;
            ctx.accounts.claim.allocated_amount = allocation;
            ctx.accounts.claim.status = if ctx.accounts.state_edge.conflicting {
                ClaimStatus::Conflicting
            } else {
                ClaimStatus::Valid
            };
            if ctx.accounts.state_edge.conflicting {
                ctx.accounts.session.conflicting_claim_count = ctx
                    .accounts
                    .session
                    .conflicting_claim_count
                    .checked_add(1)
                    .ok_or(OgpError::ArithmeticOverflow)?;
            }
            ctx.accounts.session.allocated_edge_count = ctx
                .accounts
                .session
                .allocated_edge_count
                .checked_add(1)
                .ok_or(OgpError::ArithmeticOverflow)?;
            ctx.accounts.session.allocated_total = ctx
                .accounts
                .session
                .allocated_total
                .checked_add(allocation)
                .ok_or(OgpError::ArithmeticOverflow)?;
            ctx.accounts.session.resolution_hash = hashv(&[
                b"OGP:RESOLUTION:EDGE:V1\0",
                &ctx.accounts.session.resolution_hash,
                &ctx.accounts.claim.credential_hash,
                &ctx.accounts.state_edge.previous_state_hash,
                &ctx.accounts.state_edge.sequence.to_le_bytes(),
                &ctx.accounts.state_edge.new_state_hash,
                ctx.accounts.claim.merchant.as_ref(),
                &ctx.accounts.claim.amount.to_le_bytes(),
                &allocation.to_le_bytes(),
                &[ctx.accounts.claim.status as u8],
            ])
            .to_bytes();
            if allocation == 0 {
                ctx.accounts.claim.status = ClaimStatus::Settled;
                ctx.accounts.session.settled_edge_count = ctx
                    .accounts
                    .session
                    .settled_edge_count
                    .checked_add(1)
                    .ok_or(OgpError::ArithmeticOverflow)?;
            }
        } else {
            require!(
                ctx.accounts.claim.status == ClaimStatus::Rejected
                    && ctx.accounts.claim.rejection_reason
                        == ClaimRejectionReason::DuplicateStateEdge,
                OgpError::InvalidFinalization
            );
        }

        ctx.accounts.claim.allocation_processed = true;
        ctx.accounts.session.scanned_claim_count = ctx
            .accounts
            .session
            .scanned_claim_count
            .checked_add(1)
            .ok_or(OgpError::ArithmeticOverflow)?;
        ctx.accounts.session.next_allocation_claim = ctx.accounts.claim.next_claim;
        if ctx.accounts.session.scanned_claim_count == ctx.accounts.session.submitted_claim_count {
            complete_allocation(&mut ctx.accounts.session, &mut ctx.accounts.vault)?;
        }
        Ok(())
    }

    pub fn settle_claim(ctx: Context<SettleClaim>) -> Result<()> {
        require!(
            ctx.accounts.session.allocation_complete
                && matches!(
                    ctx.accounts.session.status,
                    SessionStatus::Reconciling
                        | SessionStatus::Conflicted
                        | SessionStatus::Insolvent
                ),
            OgpError::InvalidSessionStatus
        );
        require!(
            matches!(
                ctx.accounts.claim.status,
                ClaimStatus::Valid | ClaimStatus::Conflicting
            ) && ctx.accounts.claim.allocated_amount > 0
                && ctx.accounts.claim.settled_amount == 0
                && ctx.accounts.state_edge.allocation_finalized
                && ctx.accounts.state_edge.settled_amount == 0
                && ctx.accounts.state_edge.representative_credential_hash
                    == ctx.accounts.claim.credential_hash
                && ctx.accounts.state_edge.allocated_amount == ctx.accounts.claim.allocated_amount,
            OgpError::InvalidSettlement
        );
        require!(
            ctx.accounts.state_edge.merchant == ctx.accounts.claim.merchant
                && ctx.accounts.state_edge.amount == ctx.accounts.claim.amount
                && ctx.accounts.state_edge.sequence == ctx.accounts.claim.sequence
                && ctx.accounts.state_edge.previous_state_hash
                    == ctx.accounts.claim.previous_state_hash
                && ctx.accounts.state_edge.new_state_hash == ctx.accounts.claim.new_state_hash,
            OgpError::InvalidSettlement
        );
        let amount = ctx.accounts.claim.allocated_amount;
        let owner_key = ctx.accounts.vault.owner;
        let mint_key = ctx.accounts.settlement_mint.key();
        let bump = [ctx.accounts.vault.bump];
        let signer: &[&[u8]] = &[b"vault", owner_key.as_ref(), mint_key.as_ref(), &bump];
        token::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                TransferChecked {
                    from: ctx.accounts.vault_token.to_account_info(),
                    mint: ctx.accounts.settlement_mint.to_account_info(),
                    to: ctx.accounts.merchant_token.to_account_info(),
                    authority: ctx.accounts.vault.to_account_info(),
                },
                &[signer],
            ),
            amount,
            ctx.accounts.settlement_mint.decimals,
        )?;
        ctx.accounts.claim.settled_amount = amount;
        ctx.accounts.claim.status = ClaimStatus::Settled;
        ctx.accounts.state_edge.settled_amount = amount;
        ctx.accounts.session.settled_amount = ctx
            .accounts
            .session
            .settled_amount
            .checked_add(amount)
            .ok_or(OgpError::ArithmeticOverflow)?;
        ctx.accounts.session.settled_edge_count = ctx
            .accounts
            .session
            .settled_edge_count
            .checked_add(1)
            .ok_or(OgpError::ArithmeticOverflow)?;
        ctx.accounts.vault.deposited_amount = ctx
            .accounts
            .vault
            .deposited_amount
            .checked_sub(amount)
            .ok_or(OgpError::ArithmeticOverflow)?;
        ctx.accounts.vault.reserved_amount = ctx
            .accounts
            .vault
            .reserved_amount
            .checked_sub(amount)
            .ok_or(OgpError::ArithmeticOverflow)?;
        ctx.accounts.vault.settled_from_collateral = ctx
            .accounts
            .vault
            .settled_from_collateral
            .checked_add(amount)
            .ok_or(OgpError::ArithmeticOverflow)?;
        emit!(ClaimSettled {
            session: ctx.accounts.session.key(),
            claim: ctx.accounts.claim.key(),
            merchant: ctx.accounts.claim.merchant,
            amount,
            settled_total: ctx.accounts.session.settled_amount,
        });
        if ctx.accounts.session.settled_edge_count == ctx.accounts.session.allocated_edge_count {
            if matches!(
                ctx.accounts.session.status,
                SessionStatus::Conflicted | SessionStatus::Insolvent
            ) {
                close_session_state(&mut ctx.accounts.session, &mut ctx.accounts.profile)?;
            } else {
                ctx.accounts.session.status = SessionStatus::Settled;
            }
        }
        Ok(())
    }

    pub fn close_session(ctx: Context<CloseSession>) -> Result<()> {
        require!(
            ctx.accounts.session.allocation_complete
                && ctx.accounts.session.settled_amount == ctx.accounts.session.allocated_total
                && matches!(
                    ctx.accounts.session.status,
                    SessionStatus::Reconciling
                        | SessionStatus::Settled
                        | SessionStatus::Conflicted
                        | SessionStatus::Insolvent
                ),
            OgpError::InvalidSessionStatus
        );
        close_session_state(&mut ctx.accounts.session, &mut ctx.accounts.profile)
    }

    pub fn withdraw_collateral(ctx: Context<WithdrawCollateral>, amount: u64) -> Result<()> {
        require_not_paused(&ctx.accounts.config)?;
        require!(amount > 0, OgpError::InvalidAmount);
        let book_withdrawable = ctx
            .accounts
            .vault
            .deposited_amount
            .checked_sub(ctx.accounts.vault.reserved_amount)
            .ok_or(OgpError::VaultBalanceMismatch)?;
        let real_withdrawable = ctx
            .accounts
            .vault_token
            .amount
            .checked_sub(ctx.accounts.vault.reserved_amount)
            .ok_or(OgpError::VaultBalanceMismatch)?;
        require!(
            amount <= book_withdrawable && amount <= real_withdrawable,
            OgpError::InsufficientAvailableCollateral
        );
        let owner_key = ctx.accounts.owner.key();
        let mint_key = ctx.accounts.settlement_mint.key();
        let bump = [ctx.accounts.vault.bump];
        let signer: &[&[u8]] = &[b"vault", owner_key.as_ref(), mint_key.as_ref(), &bump];
        token::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                TransferChecked {
                    from: ctx.accounts.vault_token.to_account_info(),
                    mint: ctx.accounts.settlement_mint.to_account_info(),
                    to: ctx.accounts.owner_token.to_account_info(),
                    authority: ctx.accounts.vault.to_account_info(),
                },
                &[signer],
            ),
            amount,
            ctx.accounts.settlement_mint.decimals,
        )?;
        ctx.accounts.vault.deposited_amount = ctx
            .accounts
            .vault
            .deposited_amount
            .checked_sub(amount)
            .ok_or(OgpError::ArithmeticOverflow)?;
        emit!(CollateralWithdrawn {
            vault: ctx.accounts.vault.key(),
            owner: ctx.accounts.owner.key(),
            amount,
            deposited_amount: ctx.accounts.vault.deposited_amount,
            reserved_amount: ctx.accounts.vault.reserved_amount,
        });
        Ok(())
    }
}

#[allow(clippy::too_many_arguments)]
fn register_fork_child<'info>(
    session: &mut Account<'info, OfflineSession>,
    profile: &mut Account<'info, UserProfile>,
    payer: &AccountInfo<'info>,
    fork_info: &AccountInfo<'info>,
    system_program_info: &AccountInfo<'info>,
    parent_state_hash: [u8; 32],
    sequence: u32,
    child_hash: [u8; 32],
    bump: u8,
    now: i64,
) -> Result<()> {
    let session_key = session.key();
    if fork_info.owner == &crate::ID {
        let mut record: ForkRecord = read_program_account(fork_info)?;
        require!(
            record.session == session_key
                && record.parent_state_hash == parent_state_hash
                && record.sequence == sequence
                && record.branch_count > 0
                && child_hash != record.first_child_hash
                && (record.branch_count == 1 || child_hash != record.second_child_hash),
            OgpError::InvalidForkRecord
        );
        record.branch_count = record
            .branch_count
            .checked_add(1)
            .ok_or(OgpError::ArithmeticOverflow)?;
        if record.branch_count == 2 {
            record.second_child_hash = child_hash;
            session.authenticated_fork = true;
            session.status = SessionStatus::Conflicted;
            profile.offline_access_enabled = false;
            profile.conflict_count = profile
                .conflict_count
                .checked_add(1)
                .ok_or(OgpError::ArithmeticOverflow)?;
            if profile.revoked_at == 0 {
                profile.revoked_at = now;
            }
            emit!(AuthenticatedForkConfirmed {
                session: session_key,
                fork_record: *fork_info.key,
                parent_state_hash,
                sequence,
                first_child_hash: record.first_child_hash,
                second_child_hash: child_hash,
                branch_count: record.branch_count,
            });
            emit!(SessionMarkedConflicted {
                session: session_key,
                owner: session.owner,
                fork_record: *fork_info.key,
            });
            emit!(OfflineAccessRevoked {
                profile: profile.key(),
                owner: profile.owner,
                session: session_key,
                conflict_count: profile.conflict_count,
                revoked_at: profile.revoked_at,
            });
        }
        write_program_account(fork_info, &record)?;
        return Ok(());
    }

    let bump_seed = [bump];
    let sequence_bytes = sequence.to_le_bytes();
    let seeds: &[&[u8]] = &[
        b"fork",
        session_key.as_ref(),
        &parent_state_hash,
        &sequence_bytes,
        &bump_seed,
    ];
    create_program_pda(
        payer,
        fork_info,
        system_program_info,
        ForkRecord::SPACE,
        seeds,
    )?;
    write_program_account(
        fork_info,
        &ForkRecord {
            session: session_key,
            parent_state_hash,
            sequence,
            first_child_hash: child_hash,
            second_child_hash: [0; 32],
            branch_count: 1,
            bump,
        },
    )
}

fn insert_claim_in_order<'info>(
    session: &mut Account<'info, OfflineSession>,
    claim_info: &AccountInfo<'info>,
    predecessor_info: &AccountInfo<'info>,
    successor_info: &AccountInfo<'info>,
) -> Result<()> {
    let session_key = session.key();
    let mut claim: Claim = read_program_account(claim_info)?;
    require!(
        claim.session == session_key
            && claim.previous_claim == Pubkey::default()
            && claim.next_claim == Pubkey::default(),
        OgpError::InvalidClaimOrder
    );

    if session.submitted_claim_count == 0 && session.claim_head == Pubkey::default() {
        require_keys_eq!(
            predecessor_info.key(),
            session_key,
            OgpError::InvalidClaimOrder
        );
        require_keys_eq!(
            successor_info.key(),
            session_key,
            OgpError::InvalidClaimOrder
        );
        session.claim_head = claim_info.key();
        session.claim_tail = claim_info.key();
    } else {
        let predecessor_is_sentinel = predecessor_info.key() == session_key;
        let successor_is_sentinel = successor_info.key() == session_key;
        require!(
            !(predecessor_is_sentinel && successor_is_sentinel),
            OgpError::InvalidClaimOrder
        );

        if predecessor_is_sentinel {
            require_keys_eq!(
                successor_info.key(),
                session.claim_head,
                OgpError::InvalidClaimOrder
            );
            let mut successor: Claim = read_program_account(successor_info)?;
            require!(
                successor.session == session_key
                    && successor.previous_claim == Pubkey::default()
                    && claim.credential_hash < successor.credential_hash,
                OgpError::InvalidClaimOrder
            );
            successor.previous_claim = claim_info.key();
            write_program_account(successor_info, &successor)?;
            claim.next_claim = successor_info.key();
            session.claim_head = claim_info.key();
        } else if successor_is_sentinel {
            require_keys_eq!(
                predecessor_info.key(),
                session.claim_tail,
                OgpError::InvalidClaimOrder
            );
            let mut predecessor: Claim = read_program_account(predecessor_info)?;
            require!(
                predecessor.session == session_key
                    && predecessor.next_claim == Pubkey::default()
                    && predecessor.credential_hash < claim.credential_hash,
                OgpError::InvalidClaimOrder
            );
            predecessor.next_claim = claim_info.key();
            write_program_account(predecessor_info, &predecessor)?;
            claim.previous_claim = predecessor_info.key();
            session.claim_tail = claim_info.key();
        } else {
            let mut predecessor: Claim = read_program_account(predecessor_info)?;
            let mut successor: Claim = read_program_account(successor_info)?;
            require!(
                predecessor.session == session_key
                    && successor.session == session_key
                    && predecessor.next_claim == successor_info.key()
                    && successor.previous_claim == predecessor_info.key()
                    && predecessor.credential_hash < claim.credential_hash
                    && claim.credential_hash < successor.credential_hash,
                OgpError::InvalidClaimOrder
            );
            predecessor.next_claim = claim_info.key();
            successor.previous_claim = claim_info.key();
            write_program_account(predecessor_info, &predecessor)?;
            write_program_account(successor_info, &successor)?;
            claim.previous_claim = predecessor_info.key();
            claim.next_claim = successor_info.key();
        }
    }
    write_program_account(claim_info, &claim)?;
    session.submitted_claim_count = session
        .submitted_claim_count
        .checked_add(1)
        .ok_or(OgpError::ArithmeticOverflow)?;
    Ok(())
}

fn validate_edge_identity(
    session_key: Pubkey,
    edge: &StateEdgeRecord,
    fork_record: &ForkRecord,
) -> Result<()> {
    require!(
        edge.session == session_key
            && fork_record.session == session_key
            && fork_record.parent_state_hash == edge.previous_state_hash
            && fork_record.sequence == edge.sequence
            && fork_record.branch_count > 0,
        OgpError::InvalidFinalization
    );
    Ok(())
}

fn validate_parent_edge(
    session_key: Pubkey,
    edge: &StateEdgeRecord,
    parent_info: &AccountInfo,
    parent: &StateEdgeRecord,
) -> Result<()> {
    require!(
        parent.session == session_key
            && parent.new_state_hash == edge.previous_state_hash
            && parent.sequence.checked_add(1) == Some(edge.sequence)
            && parent.new_remaining == edge.previous_remaining,
        OgpError::InvalidClaimParent
    );
    let parent_sequence = parent.sequence.to_le_bytes();
    let (expected, _) = Pubkey::find_program_address(
        &[
            b"edge",
            session_key.as_ref(),
            &parent.previous_state_hash,
            &parent_sequence,
            &parent.new_state_hash,
        ],
        &crate::ID,
    );
    require_keys_eq!(expected, parent_info.key(), OgpError::InvalidClaimParent);
    Ok(())
}

fn complete_allocation(
    session: &mut Account<OfflineSession>,
    vault: &mut Account<CollateralVault>,
) -> Result<()> {
    require!(
        session.classification_complete
            && session.scanned_claim_count == session.submitted_claim_count
            && session.allocated_edge_count == session.frozen_edge_count
            && session.next_allocation_claim == Pubkey::default(),
        OgpError::InvalidFinalization
    );
    let coverage = coverage_amount(session.frozen_exposure, session.collateral_coverage_cap);
    require!(
        session.allocated_total == coverage,
        OgpError::InvalidFinalization
    );
    let released = session
        .collateral_coverage_cap
        .checked_sub(coverage)
        .ok_or(OgpError::ArithmeticOverflow)?;
    vault.reserved_amount = vault
        .reserved_amount
        .checked_sub(released)
        .ok_or(OgpError::ArithmeticOverflow)?;
    session.coverage_status = if session.frozen_exposure <= session.collateral_coverage_cap {
        CoverageStatus::FullyCovered
    } else {
        CoverageStatus::Insolvent
    };
    session.status = if session.frozen_exposure > session.collateral_coverage_cap {
        SessionStatus::Insolvent
    } else if session.authenticated_fork {
        SessionStatus::Conflicted
    } else {
        SessionStatus::Reconciling
    };
    session.allocation_complete = true;
    emit!(CoverageCalculated {
        session: session.key(),
        aggregate_offline_exposure: session.frozen_exposure,
        collateral_coverage_cap: session.collateral_coverage_cap,
        allocated_total: session.allocated_total,
        coverage_status: session.coverage_status,
        resolution_hash: session.resolution_hash,
    });
    emit!(CollateralCoverageApplied {
        session: session.key(),
        vault: vault.key(),
        collateral_used: coverage,
        collateral_released: released,
        outstanding_reserve: coverage,
    });
    Ok(())
}

fn close_session_state(
    session: &mut Account<OfflineSession>,
    profile: &mut Account<UserProfile>,
) -> Result<()> {
    require_keys_eq!(
        profile.active_session,
        session.key(),
        OgpError::InvalidFinalization
    );
    let successful =
        !session.authenticated_fork && session.frozen_exposure <= session.collateral_coverage_cap;
    if successful {
        profile.successful_sessions = profile
            .successful_sessions
            .checked_add(1)
            .ok_or(OgpError::ArithmeticOverflow)?;
    }
    profile.active_session = Pubkey::default();
    session.status = SessionStatus::Closed;
    emit!(SessionClosed {
        session: session.key(),
        owner: session.owner,
        authenticated_fork: session.authenticated_fork,
        coverage_status: session.coverage_status,
        settled_amount: session.settled_amount,
    });
    Ok(())
}

fn validate_reachable_parent(
    session_key: Pubkey,
    session: &OfflineSession,
    parent_info: &AccountInfo,
    payload: &claims::PaymentCredentialPayloadV1,
) -> Result<()> {
    if payload.sequence == 1 {
        require_keys_eq!(*parent_info.key, session_key, OgpError::InvalidClaimParent);
        require!(
            payload.previous_state_hash == session.genesis_state_hash
                && payload.previous_remaining == session.branch_spending_limit,
            OgpError::InvalidClaimParent
        );
        return Ok(());
    }
    let parent: StateEdgeRecord = read_program_account(parent_info)?;
    let parent_sequence = parent
        .sequence
        .checked_add(1)
        .ok_or(OgpError::ArithmeticOverflow)?;
    require!(
        parent.session == session_key
            && parent.new_state_hash == payload.previous_state_hash
            && parent_sequence == payload.sequence
            && parent.new_remaining == payload.previous_remaining,
        OgpError::InvalidClaimParent
    );
    let sequence_bytes = parent.sequence.to_le_bytes();
    let (expected_parent, _) = Pubkey::find_program_address(
        &[
            b"edge",
            session_key.as_ref(),
            &parent.previous_state_hash,
            &sequence_bytes,
            &parent.new_state_hash,
        ],
        &crate::ID,
    );
    require_keys_eq!(
        expected_parent,
        *parent_info.key,
        OgpError::InvalidClaimParent
    );
    Ok(())
}

fn require_not_paused(config: &ProtocolConfig) -> Result<()> {
    require!(!config.paused, OgpError::ProtocolPaused);
    Ok(())
}

fn can_change_pause(admin: Pubkey, emergency: Pubkey, authority: Pubkey, paused: bool) -> bool {
    authority == admin || (paused && authority == emergency)
}

fn validate_session_material(owner: Pubkey, device: Pubkey, session_id: &[u8; 32]) -> Result<()> {
    require!(
        device != Pubkey::default(),
        OgpError::InvalidSessionMaterial
    );
    require!(device != owner, OgpError::DeviceKeyEqualsOwner);
    require!(
        session_id.iter().any(|byte| *byte != 0),
        OgpError::InvalidSessionMaterial
    );
    Ok(())
}

fn validate_authorities(
    admin: Pubkey,
    emergency: Pubkey,
    identity: Pubkey,
    certificate: Pubkey,
) -> Result<()> {
    let values = [admin, emergency, identity, certificate];
    require!(
        values.iter().all(|key| *key != Pubkey::default()),
        OgpError::InvalidAuthorities
    );
    for left in 0..values.len() {
        for right in (left + 1)..values.len() {
            require!(values[left] != values[right], OgpError::InvalidAuthorities);
        }
    }
    Ok(())
}

#[derive(Accounts)]
pub struct InitializeProtocol<'info> {
    #[account(init, payer = admin, space = ProtocolConfig::SPACE, seeds = [b"config"], bump)]
    pub config: Account<'info, ProtocolConfig>,
    pub settlement_mint: Account<'info, Mint>,
    #[account(mut)]
    pub admin: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetPaused<'info> {
    #[account(mut, seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, ProtocolConfig>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct CreateUserProfile<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, ProtocolConfig>,
    #[account(mut, address = config.identity_authority @ OgpError::Unauthorized)]
    pub identity_authority: Signer<'info>,
    /// CHECK: The identity authority chooses the subject; the owner need not be online.
    pub owner: UncheckedAccount<'info>,
    #[account(init, payer = identity_authority, space = UserProfile::SPACE, seeds = [b"user", owner.key().as_ref()], bump)]
    pub profile: Account<'info, UserProfile>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CreateVault<'info> {
    #[account(seeds = [b"config"], bump = config.bump, has_one = settlement_mint)]
    pub config: Account<'info, ProtocolConfig>,
    #[account(mut)]
    pub owner: Signer<'info>,
    pub settlement_mint: Account<'info, Mint>,
    #[account(init, payer = owner, space = CollateralVault::SPACE, seeds = [b"vault", owner.key().as_ref(), settlement_mint.key().as_ref()], bump)]
    pub vault: Account<'info, CollateralVault>,
    #[account(init, payer = owner, seeds = [b"vault-token", vault.key().as_ref()], bump, token::mint = settlement_mint, token::authority = vault)]
    pub vault_token: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct DepositCollateral<'info> {
    #[account(seeds = [b"config"], bump = config.bump, has_one = settlement_mint)]
    pub config: Account<'info, ProtocolConfig>,
    pub settlement_mint: Account<'info, Mint>,
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut, seeds = [b"vault", owner.key().as_ref(), settlement_mint.key().as_ref()], bump = vault.bump, has_one = owner, constraint = vault.token_mint == settlement_mint.key() @ OgpError::VaultBalanceMismatch, constraint = vault.token_account == vault_token.key() @ OgpError::VaultBalanceMismatch)]
    pub vault: Account<'info, CollateralVault>,
    #[account(mut, constraint = owner_token.owner == owner.key() @ OgpError::Unauthorized, constraint = owner_token.mint == settlement_mint.key() @ OgpError::VaultBalanceMismatch)]
    pub owner_token: Account<'info, TokenAccount>,
    #[account(mut, seeds = [b"vault-token", vault.key().as_ref()], bump = vault.token_account_bump, token::mint = settlement_mint, token::authority = vault)]
    pub vault_token: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
#[instruction(session_id: [u8; 32])]
pub struct CreateOfflineSession<'info> {
    #[account(seeds = [b"config"], bump = config.bump, has_one = settlement_mint)]
    pub config: Account<'info, ProtocolConfig>,
    pub settlement_mint: Account<'info, Mint>,
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut, seeds = [b"user", owner.key().as_ref()], bump = profile.bump, has_one = owner)]
    pub profile: Account<'info, UserProfile>,
    #[account(mut, seeds = [b"vault", owner.key().as_ref(), settlement_mint.key().as_ref()], bump = vault.bump, has_one = owner, constraint = vault.token_mint == settlement_mint.key() @ OgpError::VaultBalanceMismatch, constraint = vault.token_account == vault_token.key() @ OgpError::VaultBalanceMismatch)]
    pub vault: Account<'info, CollateralVault>,
    #[account(seeds = [b"vault-token", vault.key().as_ref()], bump = vault.token_account_bump, token::mint = settlement_mint, token::authority = vault)]
    pub vault_token: Account<'info, TokenAccount>,
    #[account(init, payer = owner, space = OfflineSession::SPACE, seeds = [b"session", owner.key().as_ref(), session_id.as_ref()], bump)]
    pub session: Box<Account<'info, OfflineSession>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RegisterDeviceAuthorization<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, ProtocolConfig>,
    pub owner: Signer<'info>,
    #[account(mut, seeds = [b"session", owner.key().as_ref(), session.session_id.as_ref()], bump = session.bump, has_one = owner)]
    pub session: Box<Account<'info, OfflineSession>>,
}

#[derive(Accounts)]
pub struct SubmitClaim<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, ProtocolConfig>,
    #[account(mut, seeds = [b"session", session.owner.as_ref(), session.session_id.as_ref()], bump = session.bump)]
    pub session: Box<Account<'info, OfflineSession>>,
    #[account(mut, seeds = [b"user", session.owner.as_ref()], bump = profile.bump, constraint = profile.owner == session.owner @ OgpError::Unauthorized)]
    pub profile: Account<'info, UserProfile>,
    /// CHECK: Compared byte-for-byte with the signed credential settlement destination.
    pub merchant: UncheckedAccount<'info>,
    #[account(mut)]
    pub relayer: Signer<'info>,
    /// CHECK: Exact PDA, owner, discriminator, and data are validated in the handler.
    #[account(mut)]
    pub claim: UncheckedAccount<'info>,
    /// CHECK: Exact PDA, owner, discriminator, and data are validated in the handler.
    #[account(mut)]
    pub state_edge: UncheckedAccount<'info>,
    /// CHECK: Current representative Claim PDA is validated and atomically superseded when needed.
    #[account(mut)]
    pub representative_claim: UncheckedAccount<'info>,
    /// CHECK: Claim-list predecessor or the session sentinel; validated in the handler.
    #[account(mut)]
    pub predecessor_claim: UncheckedAccount<'info>,
    /// CHECK: Claim-list successor or the session sentinel; validated in the handler.
    #[account(mut)]
    pub successor_claim: UncheckedAccount<'info>,
    /// CHECK: Exact parent-key PDA, owner, discriminator, and fields are validated in the handler.
    #[account(mut)]
    pub fork_record: UncheckedAccount<'info>,
    /// CHECK: Session sentinel for sequence one or a fully validated StateEdgeRecord PDA.
    pub parent_edge: UncheckedAccount<'info>,
    /// CHECK: Address constraint pins the canonical instructions sysvar.
    #[account(address = solana_instructions_sysvar::ID)]
    pub instructions: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct BeginFinalization<'info> {
    #[account(mut, seeds = [b"session", session.owner.as_ref(), session.session_id.as_ref()], bump = session.bump)]
    pub session: Box<Account<'info, OfflineSession>>,
    #[account(mut, seeds = [b"vault", vault.owner.as_ref(), vault.token_mint.as_ref()], bump = vault.bump, constraint = session.collateral_vault == vault.key() @ OgpError::InvalidFinalization)]
    pub vault: Account<'info, CollateralVault>,
}

#[derive(Accounts)]
pub struct ClassifyEdge<'info> {
    #[account(mut, seeds = [b"session", session.owner.as_ref(), session.session_id.as_ref()], bump = session.bump)]
    pub session: Box<Account<'info, OfflineSession>>,
    #[account(mut, seeds = [b"edge", session.key().as_ref(), state_edge.previous_state_hash.as_ref(), &state_edge.sequence.to_le_bytes(), state_edge.new_state_hash.as_ref()], bump = state_edge.bump, constraint = state_edge.session == session.key() @ OgpError::InvalidFinalization)]
    pub state_edge: Box<Account<'info, StateEdgeRecord>>,
    #[account(seeds = [b"fork", session.key().as_ref(), state_edge.previous_state_hash.as_ref(), &state_edge.sequence.to_le_bytes()], bump = fork_record.bump)]
    pub fork_record: Box<Account<'info, ForkRecord>>,
    /// CHECK: Session sentinel or validated, already-classified parent StateEdgeRecord.
    pub parent_edge: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct AllocateNextClaim<'info> {
    #[account(mut, seeds = [b"session", session.owner.as_ref(), session.session_id.as_ref()], bump = session.bump)]
    pub session: Box<Account<'info, OfflineSession>>,
    #[account(mut, seeds = [b"vault", vault.owner.as_ref(), vault.token_mint.as_ref()], bump = vault.bump, constraint = session.collateral_vault == vault.key() @ OgpError::InvalidFinalization)]
    pub vault: Account<'info, CollateralVault>,
    #[account(mut, seeds = [b"claim", session.key().as_ref(), claim.credential_hash.as_ref()], bump = claim.bump, constraint = claim.session == session.key() @ OgpError::InvalidFinalization)]
    pub claim: Box<Account<'info, Claim>>,
    #[account(mut, seeds = [b"edge", session.key().as_ref(), state_edge.previous_state_hash.as_ref(), &state_edge.sequence.to_le_bytes(), state_edge.new_state_hash.as_ref()], bump = state_edge.bump, constraint = state_edge.session == session.key() @ OgpError::InvalidFinalization)]
    pub state_edge: Box<Account<'info, StateEdgeRecord>>,
}

#[derive(Accounts)]
pub struct SettleClaim<'info> {
    #[account(seeds = [b"config"], bump = config.bump, has_one = settlement_mint)]
    pub config: Account<'info, ProtocolConfig>,
    pub settlement_mint: Account<'info, Mint>,
    #[account(mut, seeds = [b"session", session.owner.as_ref(), session.session_id.as_ref()], bump = session.bump)]
    pub session: Box<Account<'info, OfflineSession>>,
    #[account(mut, seeds = [b"user", session.owner.as_ref()], bump = profile.bump, constraint = profile.owner == session.owner @ OgpError::Unauthorized)]
    pub profile: Account<'info, UserProfile>,
    #[account(mut, seeds = [b"vault", vault.owner.as_ref(), settlement_mint.key().as_ref()], bump = vault.bump, constraint = session.collateral_vault == vault.key() @ OgpError::InvalidSettlement, constraint = vault.token_account == vault_token.key() @ OgpError::InvalidSettlement)]
    pub vault: Account<'info, CollateralVault>,
    #[account(mut, seeds = [b"vault-token", vault.key().as_ref()], bump = vault.token_account_bump, token::mint = settlement_mint, token::authority = vault)]
    pub vault_token: Account<'info, TokenAccount>,
    #[account(mut, seeds = [b"claim", session.key().as_ref(), claim.credential_hash.as_ref()], bump = claim.bump, constraint = claim.session == session.key() @ OgpError::InvalidSettlement)]
    pub claim: Box<Account<'info, Claim>>,
    #[account(mut, seeds = [b"edge", session.key().as_ref(), state_edge.previous_state_hash.as_ref(), &state_edge.sequence.to_le_bytes(), state_edge.new_state_hash.as_ref()], bump = state_edge.bump, constraint = state_edge.session == session.key() @ OgpError::InvalidSettlement)]
    pub state_edge: Box<Account<'info, StateEdgeRecord>>,
    #[account(mut, constraint = merchant_token.owner == claim.merchant @ OgpError::InvalidSettlement, constraint = merchant_token.mint == settlement_mint.key() @ OgpError::InvalidSettlement)]
    pub merchant_token: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct CloseSession<'info> {
    #[account(mut, seeds = [b"session", session.owner.as_ref(), session.session_id.as_ref()], bump = session.bump)]
    pub session: Box<Account<'info, OfflineSession>>,
    #[account(mut, seeds = [b"user", session.owner.as_ref()], bump = profile.bump, constraint = profile.owner == session.owner @ OgpError::Unauthorized)]
    pub profile: Account<'info, UserProfile>,
}

#[derive(Accounts)]
pub struct WithdrawCollateral<'info> {
    #[account(seeds = [b"config"], bump = config.bump, has_one = settlement_mint)]
    pub config: Account<'info, ProtocolConfig>,
    pub settlement_mint: Account<'info, Mint>,
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut, seeds = [b"vault", owner.key().as_ref(), settlement_mint.key().as_ref()], bump = vault.bump, has_one = owner, constraint = vault.token_account == vault_token.key() @ OgpError::VaultBalanceMismatch)]
    pub vault: Account<'info, CollateralVault>,
    #[account(mut, seeds = [b"vault-token", vault.key().as_ref()], bump = vault.token_account_bump, token::mint = settlement_mint, token::authority = vault)]
    pub vault_token: Account<'info, TokenAccount>,
    #[account(mut, constraint = owner_token.owner == owner.key() @ OgpError::Unauthorized, constraint = owner_token.mint == settlement_mint.key() @ OgpError::VaultBalanceMismatch)]
    pub owner_token: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[event]
pub struct ProtocolInitialized {
    pub config: Pubkey,
    pub admin: Pubkey,
    pub emergency_authority: Pubkey,
    pub identity_authority: Pubkey,
    pub certificate_issuer: Pubkey,
    pub settlement_mint: Pubkey,
    pub network_id: u8,
    pub cluster_genesis_hash: [u8; 32],
    pub minimum_collateral_ratio_bps: u32,
}

#[event]
pub struct ClaimSubmitted {
    pub claim: Pubkey,
    pub state_edge: Pubkey,
    pub session: Pubkey,
    pub credential_hash: [u8; 32],
    pub merchant: Pubkey,
    pub amount: u64,
    pub sequence: u32,
    pub is_unique_edge: bool,
    pub is_economic_representative: bool,
    pub rejection_reason: ClaimRejectionReason,
    pub aggregate_offline_exposure: u64,
    pub unique_edge_count: u64,
    pub submitted_slot: u64,
}

#[event]
pub struct AuthenticatedForkConfirmed {
    pub session: Pubkey,
    pub fork_record: Pubkey,
    pub parent_state_hash: [u8; 32],
    pub sequence: u32,
    pub first_child_hash: [u8; 32],
    pub second_child_hash: [u8; 32],
    pub branch_count: u32,
}

#[event]
pub struct SessionMarkedConflicted {
    pub session: Pubkey,
    pub owner: Pubkey,
    pub fork_record: Pubkey,
}

#[event]
pub struct OfflineAccessRevoked {
    pub profile: Pubkey,
    pub owner: Pubkey,
    pub session: Pubkey,
    pub conflict_count: u32,
    pub revoked_at: i64,
}

#[event]
pub struct DeviceAuthorizationRegistered {
    pub session: Pubkey,
    pub owner: Pubkey,
    pub device_authorization_hash: [u8; 32],
}

#[event]
pub struct ProtocolPauseChanged {
    pub config: Pubkey,
    pub authority: Pubkey,
    pub paused: bool,
}

#[event]
pub struct UserProfileCreated {
    pub profile: Pubkey,
    pub owner: Pubkey,
    pub identity_issuer: Pubkey,
    pub identity_attestation_hash: [u8; 32],
    pub identity_expires_at: i64,
}

#[event]
pub struct CollateralVaultCreated {
    pub vault: Pubkey,
    pub owner: Pubkey,
    pub token_mint: Pubkey,
    pub token_account: Pubkey,
}

#[event]
pub struct CollateralDeposited {
    pub vault: Pubkey,
    pub owner: Pubkey,
    pub amount: u64,
    pub deposited_amount: u64,
    pub actual_token_balance: u64,
}

#[event]
pub struct OfflineSessionCreated {
    pub session: Pubkey,
    pub session_id: [u8; 32],
    pub owner: Pubkey,
    pub device_public_key: Pubkey,
    pub collateral_vault: Pubkey,
    pub collateral_locked: u64,
    pub branch_spending_limit: u64,
    pub collateral_coverage_cap: u64,
    pub issued_at: i64,
    pub expires_at: i64,
    pub claim_submission_deadline: i64,
}

#[event]
pub struct FinalizationStarted {
    pub session: Pubkey,
    pub frozen_edge_count: u64,
    pub frozen_exposure: u64,
    pub submitted_claim_count: u64,
}

#[event]
pub struct EdgeClassified {
    pub session: Pubkey,
    pub state_edge: Pubkey,
    pub representative_credential_hash: [u8; 32],
    pub conflicting: bool,
    pub base_allocation: u64,
}

#[event]
pub struct CoverageCalculated {
    pub session: Pubkey,
    pub aggregate_offline_exposure: u64,
    pub collateral_coverage_cap: u64,
    pub allocated_total: u64,
    pub coverage_status: CoverageStatus,
    pub resolution_hash: [u8; 32],
}

#[event]
pub struct CollateralCoverageApplied {
    pub session: Pubkey,
    pub vault: Pubkey,
    pub collateral_used: u64,
    pub collateral_released: u64,
    pub outstanding_reserve: u64,
}

#[event]
pub struct ClaimSettled {
    pub session: Pubkey,
    pub claim: Pubkey,
    pub merchant: Pubkey,
    pub amount: u64,
    pub settled_total: u64,
}

#[event]
pub struct SessionClosed {
    pub session: Pubkey,
    pub owner: Pubkey,
    pub authenticated_fork: bool,
    pub coverage_status: CoverageStatus,
    pub settled_amount: u64,
}

#[event]
pub struct CollateralWithdrawn {
    pub vault: Pubkey,
    pub owner: Pubkey,
    pub amount: u64,
    pub deposited_amount: u64,
    pub reserved_amount: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn authorities_are_separate() {
        let admin = Pubkey::new_unique();
        let emergency = Pubkey::new_unique();
        let identity = Pubkey::new_unique();
        let certificate = Pubkey::new_unique();
        assert!(validate_authorities(admin, emergency, identity, certificate).is_ok());
        assert!(validate_authorities(admin, admin, identity, certificate).is_err());
        assert!(validate_authorities(Pubkey::default(), emergency, identity, certificate).is_err());
    }

    #[test]
    fn account_spaces_are_frozen() {
        assert_eq!(ProtocolConfig::SPACE, 227);
        assert_eq!(UserProfile::SPACE, 163);
        assert_eq!(CollateralVault::SPACE, 130);
        assert_eq!(OfflineSession::SPACE, 530);
        assert_eq!(Claim::SPACE, 272);
        assert_eq!(StateEdgeRecord::SPACE, 228);
        assert_eq!(ForkRecord::SPACE, 145);
    }

    #[test]
    fn emergency_authority_can_only_pause() {
        let admin = Pubkey::new_unique();
        let emergency = Pubkey::new_unique();
        assert!(can_change_pause(admin, emergency, emergency, true));
        assert!(!can_change_pause(admin, emergency, emergency, false));
        assert!(can_change_pause(admin, emergency, admin, true));
        assert!(can_change_pause(admin, emergency, admin, false));
        assert!(!can_change_pause(
            admin,
            emergency,
            Pubkey::new_unique(),
            true
        ));
    }

    #[test]
    fn session_material_rejects_zero_and_owner_device_keys() {
        let owner = Pubkey::new_unique();
        let device = Pubkey::new_unique();
        let nonzero = [1; 32];
        assert!(validate_session_material(owner, device, &nonzero).is_ok());
        assert!(validate_session_material(owner, Pubkey::default(), &nonzero).is_err());
        assert!(validate_session_material(owner, owner, &nonzero).is_err());
        assert!(validate_session_material(owner, device, &[0; 32]).is_err());
    }
}
