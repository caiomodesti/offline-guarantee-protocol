use anchor_lang::prelude::*;

use crate::errors::OgpError;

pub const BPS_DENOMINATOR: u128 = 10_000;

pub fn validate_session_economics(
    collateral_locked: u64,
    branch_spending_limit: u64,
    minimum_ratio_bps: u32,
) -> Result<()> {
    require!(
        collateral_locked > 0 && branch_spending_limit > 0,
        OgpError::InvalidAmount
    );
    let locked = u128::from(collateral_locked);
    let branch = u128::from(branch_spending_limit);
    let ratio = u128::from(minimum_ratio_bps);
    require!(
        locked
            .checked_mul(BPS_DENOMINATOR)
            .ok_or(OgpError::ArithmeticOverflow)?
            >= branch
                .checked_mul(ratio)
                .ok_or(OgpError::ArithmeticOverflow)?,
        OgpError::InsufficientCollateralRatio
    );
    Ok(())
}

pub fn claim_submission_deadline(expires_at: i64, grace_seconds: i64) -> Result<i64> {
    expires_at
        .checked_add(grace_seconds)
        .ok_or_else(|| error!(OgpError::ArithmeticOverflow))
}

pub fn validate_session_window(now: i64, expires_at: i64, max_duration: i64) -> Result<()> {
    let duration = expires_at
        .checked_sub(now)
        .ok_or(OgpError::ArithmeticOverflow)?;
    require!(
        duration > 0 && duration <= max_duration,
        OgpError::InvalidSessionWindow
    );
    Ok(())
}

pub fn checked_deposit(deposited: u64, amount: u64, actual_after: u64) -> Result<u64> {
    require!(amount > 0, OgpError::InvalidAmount);
    let new_deposited = deposited
        .checked_add(amount)
        .ok_or(OgpError::ArithmeticOverflow)?;
    require!(
        actual_after >= new_deposited,
        OgpError::VaultBalanceMismatch
    );
    Ok(new_deposited)
}

pub fn checked_reservation(
    deposited: u64,
    reserved: u64,
    actual_balance: u64,
    collateral_locked: u64,
) -> Result<u64> {
    require!(collateral_locked > 0, OgpError::InvalidAmount);
    let new_reserved = reserved
        .checked_add(collateral_locked)
        .ok_or(OgpError::ArithmeticOverflow)?;
    require!(
        new_reserved <= deposited && new_reserved <= actual_balance,
        OgpError::InsufficientAvailableCollateral
    );
    Ok(new_reserved)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn official_ratio_example_passes() {
        assert!(validate_session_economics(50_000, 15_000, 30_000).is_ok());
    }

    #[test]
    fn undercollateralized_session_fails() {
        assert!(validate_session_economics(50_000, 30_000, 30_000).is_err());
    }

    #[test]
    fn ratio_boundary_is_exact() {
        assert!(validate_session_economics(300, 100, 30_000).is_ok());
        assert!(validate_session_economics(299, 100, 30_000).is_err());
    }

    #[test]
    fn u64_products_do_not_overflow() {
        assert!(validate_session_economics(u64::MAX, u64::MAX, 10_000).is_ok());
    }

    #[test]
    fn deadline_is_checked() {
        assert_eq!(claim_submission_deadline(10_800, 21_600).unwrap(), 32_400);
        assert!(claim_submission_deadline(i64::MAX, 1).is_err());
    }

    #[test]
    fn session_window_has_strict_bounds() {
        assert!(validate_session_window(100, 10_900, 10_800).is_ok());
        assert!(validate_session_window(100, 100, 10_800).is_err());
        assert!(validate_session_window(100, 10_901, 10_800).is_err());
    }

    #[test]
    fn deposit_checks_overflow_and_actual_balance() {
        assert_eq!(checked_deposit(100, 50, 150).unwrap(), 150);
        assert!(checked_deposit(u64::MAX, 1, u64::MAX).is_err());
        assert!(checked_deposit(100, 50, 149).is_err());
    }

    #[test]
    fn reservation_checks_book_and_token_balances() {
        assert_eq!(checked_reservation(500, 100, 500, 400).unwrap(), 500);
        assert!(checked_reservation(499, 100, 500, 400).is_err());
        assert!(checked_reservation(500, 100, 499, 400).is_err());
    }
}
