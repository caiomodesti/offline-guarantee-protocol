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

pub fn coverage_amount(total_exposure: u64, collateral_cap: u64) -> u64 {
    total_exposure.min(collateral_cap)
}

pub fn checked_base_allocation(
    amount: u64,
    total_exposure: u64,
    collateral_cap: u64,
) -> Result<u64> {
    require!(
        total_exposure > 0 && amount <= total_exposure,
        OgpError::InvalidFinalization
    );
    let coverage = coverage_amount(total_exposure, collateral_cap);
    let product = u128::from(amount)
        .checked_mul(u128::from(coverage))
        .ok_or(OgpError::ArithmeticOverflow)?;
    u64::try_from(product / u128::from(total_exposure))
        .map_err(|_| error!(OgpError::ArithmeticOverflow))
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

    #[test]
    fn official_pro_rata_example_is_exact_and_deterministic() {
        let amounts = [30_000, 20_000, 15_000];
        let bases: Vec<u64> = amounts
            .into_iter()
            .map(|amount| checked_base_allocation(amount, 65_000, 50_000).unwrap())
            .collect();
        assert_eq!(bases, [23_076, 15_384, 11_538]);
        let remainder = 50_000 - bases.iter().sum::<u64>();
        assert_eq!(remainder, 2);
        let allocations: Vec<u64> = bases
            .into_iter()
            .enumerate()
            .map(|(index, base)| base + u64::from(index < remainder as usize))
            .collect();
        assert_eq!(allocations, [23_077, 15_385, 11_538]);
        assert_eq!(allocations.iter().sum::<u64>(), 50_000);
    }

    #[test]
    fn base_allocation_handles_u64_products_without_overflow() {
        assert_eq!(
            checked_base_allocation(u64::MAX, u64::MAX, u64::MAX).unwrap(),
            u64::MAX
        );
        assert!(checked_base_allocation(1, 0, 1).is_err());
        assert!(checked_base_allocation(2, 1, 1).is_err());
    }

    #[test]
    fn pro_rata_liability_never_exceeds_cap_over_reproducible_grid() {
        fn assert_allocation(amounts: &[u64], cap: u64) {
            let exposure = amounts
                .iter()
                .try_fold(0u64, |total, amount| total.checked_add(*amount))
                .expect("test material must fit u64");
            let coverage = exposure.min(cap);
            let bases: Vec<u64> = amounts
                .iter()
                .map(|amount| checked_base_allocation(*amount, exposure, cap).unwrap())
                .collect();
            let base_total = bases
                .iter()
                .try_fold(0u64, |total, base| total.checked_add(*base))
                .unwrap();
            let remainder = coverage.checked_sub(base_total).unwrap();
            assert!(remainder <= amounts.len() as u64);
            let allocations: Vec<u64> = bases
                .iter()
                .enumerate()
                .map(|(index, base)| {
                    base.checked_add(u64::from((index as u64) < remainder))
                        .unwrap()
                })
                .collect();
            assert!(allocations
                .iter()
                .zip(amounts)
                .all(|(allocation, amount)| allocation <= amount));
            assert_eq!(allocations.iter().sum::<u64>(), coverage);
            assert!(coverage <= cap);
        }

        assert_allocation(&[u64::MAX], u64::MAX);
        assert_allocation(&[u64::MAX - 1, 1], u64::MAX - 1);
        assert_allocation(&[1, 1, 1], 2);

        // Fixed LCG seed makes every generated regression reproducible without
        // adding a new property-test dependency to the SBF program crate.
        let mut state = 0x0a6f_3303_5eed_u64;
        for _ in 0..4_096 {
            state = state
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1);
            let edge_count = usize::try_from(state % 16 + 1).unwrap();
            let mut amounts = Vec::with_capacity(edge_count);
            for _ in 0..edge_count {
                state = state
                    .wrapping_mul(6_364_136_223_846_793_005)
                    .wrapping_add(1);
                amounts.push(state % 1_000_000 + 1);
            }
            state = state
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1);
            assert_allocation(&amounts, state % 16_000_001);
        }
    }
}
