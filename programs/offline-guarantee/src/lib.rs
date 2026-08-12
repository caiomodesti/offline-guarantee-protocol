#![allow(unexpected_cfgs)]

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, TransferChecked};

pub mod errors;
pub mod math;
pub mod state;

use errors::OgpError;
use math::{
    checked_deposit, checked_reservation, claim_submission_deadline, validate_session_economics,
    validate_session_window,
};
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
    ) -> Result<()> {
        validate_authorities(
            ctx.accounts.admin.key(),
            emergency_authority,
            identity_authority,
            certificate_issuer,
        )?;
        let config = &mut ctx.accounts.config;
        config.admin = ctx.accounts.admin.key();
        config.emergency_authority = emergency_authority;
        config.identity_authority = identity_authority;
        config.certificate_issuer = certificate_issuer;
        config.settlement_mint = ctx.accounts.settlement_mint.key();
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
        genesis_state_hash: [u8; 32],
        device_authorization_hash: [u8; 32],
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
        validate_session_material(
            ctx.accounts.owner.key(),
            device_public_key,
            &session_id,
            &genesis_state_hash,
            &device_authorization_hash,
        )?;
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
        let deadline =
            claim_submission_deadline(expires_at, ctx.accounts.config.claim_grace_period_seconds)?;
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
        session.device_authorization_hash = device_authorization_hash;
        session.identity_attestation_hash = ctx.accounts.profile.identity_attestation_hash;
        session.settled_amount = 0;
        session.aggregate_offline_exposure = 0;
        session.conflicting_claim_count = 0;
        session.resolution_hash = [0; 32];
        session.bump = ctx.bumps.session;
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
}

fn require_not_paused(config: &ProtocolConfig) -> Result<()> {
    require!(!config.paused, OgpError::ProtocolPaused);
    Ok(())
}

fn can_change_pause(admin: Pubkey, emergency: Pubkey, authority: Pubkey, paused: bool) -> bool {
    authority == admin || (paused && authority == emergency)
}

fn validate_session_material(
    owner: Pubkey,
    device: Pubkey,
    session_id: &[u8; 32],
    genesis_state_hash: &[u8; 32],
    device_authorization_hash: &[u8; 32],
) -> Result<()> {
    require!(
        device != Pubkey::default(),
        OgpError::InvalidSessionMaterial
    );
    require!(device != owner, OgpError::DeviceKeyEqualsOwner);
    require!(
        session_id.iter().any(|byte| *byte != 0)
            && genesis_state_hash.iter().any(|byte| *byte != 0)
            && device_authorization_hash.iter().any(|byte| *byte != 0),
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

#[event]
pub struct ProtocolInitialized {
    pub config: Pubkey,
    pub admin: Pubkey,
    pub emergency_authority: Pubkey,
    pub identity_authority: Pubkey,
    pub certificate_issuer: Pubkey,
    pub settlement_mint: Pubkey,
    pub minimum_collateral_ratio_bps: u32,
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
        assert_eq!(ProtocolConfig::SPACE, 194);
        assert_eq!(UserProfile::SPACE, 163);
        assert_eq!(CollateralVault::SPACE, 130);
        assert_eq!(OfflineSession::SPACE, 344);
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
        assert!(validate_session_material(owner, device, &nonzero, &nonzero, &nonzero).is_ok());
        assert!(
            validate_session_material(owner, Pubkey::default(), &nonzero, &nonzero, &nonzero)
                .is_err()
        );
        assert!(validate_session_material(owner, owner, &nonzero, &nonzero, &nonzero).is_err());
        assert!(validate_session_material(owner, device, &[0; 32], &nonzero, &nonzero).is_err());
    }
}
