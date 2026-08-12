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
}
