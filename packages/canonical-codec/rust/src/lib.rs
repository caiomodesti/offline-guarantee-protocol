#![forbid(unsafe_code)]

#[cfg(test)]
mod tests {
    use borsh::{BorshDeserialize, BorshSerialize};
    use ed25519_dalek::{Signature, VerifyingKey};
    use serde::Deserialize;
    use sha2::{Digest, Sha256};
    use std::{collections::BTreeMap, fs, path::PathBuf};

    #[derive(BorshDeserialize, BorshSerialize)]
    struct Domain {
        protocol_name: [u8; 8],
        protocol_version: u16,
        schema_version: u16,
        object_type: u8,
        network_id: u8,
        cluster_genesis_hash: [u8; 32],
        program_id: [u8; 32],
        session_id: [u8; 32],
    }

    #[derive(BorshDeserialize, BorshSerialize)]
    struct DeviceAuthorizationPayload {
        domain: Domain,
        owner: [u8; 32],
        device_public_key: [u8; 32],
        payload_session_id: [u8; 32],
        vault: [u8; 32],
        branch_spending_limit: u64,
        collateral_coverage_cap: u64,
        max_branch_depth: u32,
        issued_at: i64,
        expires_at: i64,
        authorization_nonce: [u8; 32],
    }
    #[derive(BorshDeserialize, BorshSerialize)]
    struct DeviceAuthorization {
        payload: DeviceAuthorizationPayload,
        wallet_signature: [u8; 64],
    }

    #[derive(BorshDeserialize, BorshSerialize)]
    struct SessionCertificatePayload {
        domain: Domain,
        payload_session_id: [u8; 32],
        owner: [u8; 32],
        device_public_key: [u8; 32],
        vault: [u8; 32],
        token_mint: [u8; 32],
        branch_spending_limit: u64,
        collateral_locked: u64,
        collateral_coverage_cap: u64,
        max_branch_depth: u32,
        issued_at: i64,
        expires_at: i64,
        claim_submission_deadline: i64,
        genesis_state_hash: [u8; 32],
        device_authorization_hash: [u8; 32],
        identity_attestation_hash: [u8; 32],
        issuer: [u8; 32],
        finalized_slot: u64,
        certificate_nonce: [u8; 32],
    }
    #[derive(BorshDeserialize, BorshSerialize)]
    struct SessionCertificate {
        payload: SessionCertificatePayload,
        issuer_signature: [u8; 64],
    }

    #[derive(BorshDeserialize, BorshSerialize)]
    struct GenesisState {
        domain: Domain,
        owner: [u8; 32],
        device_public_key: [u8; 32],
        branch_spending_limit: u64,
        max_branch_depth: u32,
        initial_remaining: u64,
        issued_at: i64,
        expires_at: i64,
    }
    #[derive(BorshDeserialize, BorshSerialize)]
    struct PaymentState {
        domain: Domain,
        previous_state_hash: [u8; 32],
        sequence: u32,
        merchant: [u8; 32],
        amount: u64,
        merchant_challenge: [u8; 32],
        previous_remaining: u64,
        new_remaining: u64,
    }

    #[derive(BorshDeserialize, BorshSerialize)]
    struct PaymentCredentialPayload {
        domain: Domain,
        payload_session_id: [u8; 32],
        sequence: u32,
        payer: [u8; 32],
        payer_device_key: [u8; 32],
        merchant: [u8; 32],
        merchant_device_key: [u8; 32],
        amount: u64,
        previous_state_hash: [u8; 32],
        new_state_hash: [u8; 32],
        previous_remaining: u64,
        new_remaining: u64,
        merchant_challenge: [u8; 32],
        created_at: i64,
        session_expires_at: i64,
    }
    #[derive(BorshDeserialize, BorshSerialize)]
    struct PaymentCredential {
        payload: PaymentCredentialPayload,
        payer_signature: [u8; 64],
    }

    #[derive(BorshDeserialize, BorshSerialize)]
    struct IdentityAttestationPayload {
        domain: Domain,
        issuer: [u8; 32],
        subject_wallet: [u8; 32],
        assurance_level: u8,
        issued_at: i64,
        expires_at: i64,
        attestation_id: [u8; 32],
        status: u8,
    }
    #[derive(BorshDeserialize, BorshSerialize)]
    struct IdentityAttestation {
        payload: IdentityAttestationPayload,
        issuer_signature: [u8; 64],
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Fixture {
        format: String,
        protocol_version: u16,
        schema_version: u16,
        vectors: BTreeMap<String, Vector>,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Vector {
        payload_hex: String,
        signed_hex: Option<String>,
        public_key_hex: Option<String>,
        signature_hex: Option<String>,
        hash_hex: String,
        encoded_length: usize,
        signed_length: Option<usize>,
    }

    fn fixture() -> Fixture {
        let path =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../fixtures/golden-v1.json");
        serde_json::from_str(&fs::read_to_string(path).expect("read golden fixture"))
            .expect("parse golden fixture")
    }

    fn round_trip<T: BorshDeserialize + BorshSerialize>(encoded: &[u8]) {
        let value = T::try_from_slice(encoded).expect("strict Borsh decode");
        assert_eq!(borsh::to_vec(&value).expect("Borsh encode"), encoded);
    }

    fn verify_vector(vector: &Vector) {
        let payload = hex::decode(&vector.payload_hex).expect("payload hex");
        assert_eq!(payload.len(), vector.encoded_length);
        let signed = vector
            .signed_hex
            .as_ref()
            .map(|value| hex::decode(value).expect("signed hex"));
        let hash_input = signed.as_deref().unwrap_or(&payload);
        assert_eq!(hex::encode(Sha256::digest(hash_input)), vector.hash_hex);
        if let (Some(public_key), Some(signature)) = (&vector.public_key_hex, &vector.signature_hex)
        {
            let key_bytes: [u8; 32] = hex::decode(public_key)
                .expect("key hex")
                .try_into()
                .expect("32-byte key");
            let signature_bytes: [u8; 64] = hex::decode(signature)
                .expect("signature hex")
                .try_into()
                .expect("64-byte signature");
            VerifyingKey::from_bytes(&key_bytes)
                .expect("valid public key")
                .verify_strict(&payload, &Signature::from_bytes(&signature_bytes))
                .expect("valid strict Ed25519 signature");
            assert_eq!(
                signed.as_ref().expect("signed wrapper").len(),
                vector.signed_length.expect("signed length")
            );
            assert_eq!(
                &signed.as_ref().expect("signed wrapper")
                    [signed.as_ref().expect("signed wrapper").len() - 64..],
                signature_bytes
            );
        }
    }

    #[test]
    fn typescript_vectors_match_rust_borsh_sha256_and_ed25519() {
        let fixture = fixture();
        assert_eq!(fixture.format, "ogp-golden-v1");
        assert_eq!(fixture.protocol_version, 1);
        assert_eq!(fixture.schema_version, 1);
        for vector in fixture.vectors.values() {
            verify_vector(vector);
        }
        let vector = |name: &str| hex::decode(&fixture.vectors[name].payload_hex).expect("payload");
        round_trip::<DeviceAuthorizationPayload>(&vector("deviceAuthorization"));
        round_trip::<SessionCertificatePayload>(&vector("sessionCertificate"));
        round_trip::<GenesisState>(&vector("genesisState"));
        round_trip::<PaymentState>(&vector("paymentState"));
        round_trip::<PaymentCredentialPayload>(&vector("paymentCredential"));
        round_trip::<IdentityAttestationPayload>(&vector("identityAttestation"));
        round_trip::<DeviceAuthorization>(
            &hex::decode(
                fixture.vectors["deviceAuthorization"]
                    .signed_hex
                    .as_ref()
                    .unwrap(),
            )
            .unwrap(),
        );
        round_trip::<SessionCertificate>(
            &hex::decode(
                fixture.vectors["sessionCertificate"]
                    .signed_hex
                    .as_ref()
                    .unwrap(),
            )
            .unwrap(),
        );
        round_trip::<PaymentCredential>(
            &hex::decode(
                fixture.vectors["paymentCredential"]
                    .signed_hex
                    .as_ref()
                    .unwrap(),
            )
            .unwrap(),
        );
        round_trip::<IdentityAttestation>(
            &hex::decode(
                fixture.vectors["identityAttestation"]
                    .signed_hex
                    .as_ref()
                    .unwrap(),
            )
            .unwrap(),
        );
    }
}
