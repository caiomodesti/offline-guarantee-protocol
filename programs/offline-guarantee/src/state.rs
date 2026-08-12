use anchor_lang::prelude::*;

pub const MINIMUM_COLLATERAL_RATIO_BPS: u32 = 30_000;
pub const MAX_SESSION_DURATION_SECONDS: i64 = 3 * 60 * 60;
pub const CLAIM_GRACE_PERIOD_SECONDS: i64 = 6 * 60 * 60;
pub const MAX_BRANCH_DEPTH: u32 = 32;

#[account]
pub struct ProtocolConfig {
    pub admin: Pubkey,
    pub emergency_authority: Pubkey,
    pub identity_authority: Pubkey,
    pub certificate_issuer: Pubkey,
    pub settlement_mint: Pubkey,
    pub minimum_collateral_ratio_bps: u32,
    pub max_session_duration_seconds: i64,
    pub claim_grace_period_seconds: i64,
    pub max_branch_depth: u32,
    pub paused: bool,
    pub bump: u8,
}

impl ProtocolConfig {
    pub const SPACE: usize = 8 + (32 * 5) + 4 + 8 + 8 + 4 + 1 + 1;
}

#[account]
pub struct UserProfile {
    pub owner: Pubkey,
    pub identity_attestation_hash: [u8; 32],
    pub identity_issuer: Pubkey,
    pub risk_tier: u8,
    pub offline_access_enabled: bool,
    pub successful_sessions: u32,
    pub conflict_count: u32,
    pub revoked_at: i64,
    pub identity_expires_at: i64,
    pub active_session: Pubkey,
    pub bump: u8,
}

impl UserProfile {
    pub const SPACE: usize = 8 + 32 + 32 + 32 + 1 + 1 + 4 + 4 + 8 + 8 + 32 + 1;
}

#[account]
pub struct CollateralVault {
    pub owner: Pubkey,
    pub token_mint: Pubkey,
    pub token_account: Pubkey,
    pub deposited_amount: u64,
    pub reserved_amount: u64,
    pub settled_from_collateral: u64,
    pub bump: u8,
    pub token_account_bump: u8,
}

impl CollateralVault {
    pub const SPACE: usize = 8 + 32 + 32 + 32 + 8 + 8 + 8 + 1 + 1;
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum SessionStatus {
    Active,
    Conflicted,
    Reconciling,
    Insolvent,
    Closed,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum CoverageStatus {
    Uncalculated,
    FullyCovered,
    ProRataRequired,
}

#[account]
pub struct OfflineSession {
    pub session_id: [u8; 32],
    pub owner: Pubkey,
    pub device_public_key: Pubkey,
    pub collateral_vault: Pubkey,
    pub collateral_locked: u64,
    pub branch_spending_limit: u64,
    pub collateral_coverage_cap: u64,
    pub max_branch_depth: u32,
    pub issued_at: i64,
    pub expires_at: i64,
    pub claim_submission_deadline: i64,
    pub status: SessionStatus,
    pub authenticated_fork: bool,
    pub coverage_status: CoverageStatus,
    pub genesis_state_hash: [u8; 32],
    pub device_authorization_hash: [u8; 32],
    pub identity_attestation_hash: [u8; 32],
    pub settled_amount: u64,
    pub aggregate_offline_exposure: u64,
    pub conflicting_claim_count: u64,
    pub resolution_hash: [u8; 32],
    pub bump: u8,
}

impl OfflineSession {
    pub const SPACE: usize = 344;
}
