//! The round-trip return bands (`CANARY-12`): the pass band, the fail band and the gap
//! between them, judged on returns in parts per million rounded down, so a return is in the
//! pass band exactly when it is at least the band's share of what was put in.

use serde::Serialize;

use crate::config::{FAIL_BAND_BELOW_PPM, PASS_BAND_MIN_PPM};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Band {
    Pass,
    Between,
    Fail,
}

pub fn band(return_ppm: u64) -> Band {
    if return_ppm >= PASS_BAND_MIN_PPM {
        Band::Pass
    } else if return_ppm >= FAIL_BAND_BELOW_PPM {
        Band::Between
    } else {
        Band::Fail
    }
}

/// "95.0% or more back", from the pass band's constant.
pub fn pass_band_words() -> String {
    format!("{} or more", crate::words::percent(PASS_BAND_MIN_PPM))
}
