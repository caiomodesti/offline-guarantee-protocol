use anchor_lang::prelude::*;

#[error_code]
pub enum OgpError {
    #[msg("protocol is paused")]
    ProtocolPaused,
    #[msg("authority is not permitted to perform this action")]
    Unauthorized,
    #[msg("protocol authorities must be nonzero and distinct")]
    InvalidAuthorities,
    #[msg("protocol parameters differ from the frozen MVP profile")]
    InvalidProtocolParameters,
    #[msg("identity attestation hash must be nonzero")]
    InvalidIdentityAttestation,
    #[msg("identity attestation is expired")]
    IdentityExpired,
    #[msg("offline access is disabled for this user")]
    OfflineAccessDisabled,
    #[msg("user already has an active offline session")]
    ActiveSessionExists,
    #[msg("amount must be greater than zero")]
    InvalidAmount,
    #[msg("checked arithmetic failed")]
    ArithmeticOverflow,
    #[msg("collateral ratio is below the protocol minimum")]
    InsufficientCollateralRatio,
    #[msg("available collateral is insufficient")]
    InsufficientAvailableCollateral,
    #[msg("vault token balance is below protocol accounting")]
    VaultBalanceMismatch,
    #[msg("session identifier or cryptographic material is invalid")]
    InvalidSessionMaterial,
    #[msg("session expiry is outside the allowed window")]
    InvalidSessionWindow,
    #[msg("payer wallet and per-session device key must differ")]
    DeviceKeyEqualsOwner,
    #[msg("network identifier or cluster genesis hash is invalid")]
    InvalidNetworkDomain,
    #[msg("claim submission deadline has passed")]
    ClaimSubmissionClosed,
    #[msg("claim is not accepted in the session's current state")]
    InvalidSessionStatus,
    #[msg("canonical credential payload is malformed or uses the wrong domain")]
    InvalidCredentialPayload,
    #[msg("credential signature was not verified by the expected Ed25519 instruction")]
    InvalidEd25519Verification,
    #[msg("credential is bound to another payer, device, session, or merchant")]
    ClaimBindingMismatch,
    #[msg("credential transition arithmetic or state hash is invalid")]
    InvalidStateTransition,
    #[msg("credential parent is not a registered reachable state")]
    InvalidClaimParent,
    #[msg("credential exceeds the configured maximum branch depth")]
    BranchDepthExceeded,
    #[msg("credential challenge must be nonzero")]
    InvalidMerchantChallenge,
    #[msg("the exact credential has already been submitted")]
    DuplicateCredential,
    #[msg("claim or state-edge PDA is invalid or occupied by another account")]
    InvalidClaimAccount,
}
