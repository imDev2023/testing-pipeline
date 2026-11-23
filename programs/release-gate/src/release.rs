//! The release declaration, `programs/<program>/release.json` (`buy-wall-amm`, `lending-amm`),
//! committed with each release: whether the release changes pricing, and from which builds.
//!
//! The gate refuses a build whose quote differs from the baseline build's on the same state,
//! unless the declaration names that baseline build's executable hash under
//! `pricing_change.from`. Naming the builds, not just saying yes, means a declaration left
//! in place after its release has deployed stops covering anything, because the deployed
//! build it named is no longer the one deployed:
//!
//! ```json
//! { "pricing_change": null }
//! { "pricing_change": { "from": ["<executable sha256>"], "why": "one sentence" } }
//! ```

use std::path::Path;

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Release {
    pub pricing_change: Option<PricingChange>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PricingChange {
    /// The executable hashes of the builds whose quotes this release changes: the build
    /// deployed on the cluster, and the baseline of each fixture whose quotes it changes.
    pub from: Vec<String>,
    pub why: String,
}

impl Release {
    pub fn read(path: &Path) -> Result<Self, String> {
        let text = std::fs::read_to_string(path).map_err(|e| {
            format!(
                "cannot read the release declaration {}: {e}",
                path.display()
            )
        })?;
        let release: Release = serde_json::from_str(&text)
            .map_err(|e| format!("{} is not a release declaration: {e}", path.display()))?;
        if let Some(change) = &release.pricing_change {
            if change.from.is_empty() || change.why.trim().is_empty() {
                return Err(format!(
                    "{}: a pricing change names the builds it changes (`from`) and says why",
                    path.display()
                ));
            }
        }
        Ok(release)
    }

    /// Whether the release declares a change to the quotes of the build `baseline`.
    pub fn changes_pricing_of(&self, baseline: Option<&str>) -> bool {
        match (&self.pricing_change, baseline) {
            (Some(change), Some(hash)) => change.from.iter().any(|from| from == hash),
            _ => false,
        }
    }
}
