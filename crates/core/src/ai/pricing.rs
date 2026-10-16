//! Prices from a table delivered with the app, with its date. Unknown model → no estimate and
//! no limit protection (spec 1.5); an own price per model wins. Local providers cost nothing.
//! Costs are estimates and counted in micro-USD.

use crate::ai::provider::Usage;
use crate::model::{AiPrice, AiPriceSource, AiProviderKind, Settings};

/// Date of the built-in table (vendor price list as of this day).
pub const PRICES_AS_OF: &str = "2026-10-06";

/// (model, input USD per million tokens, output USD per million tokens).
const ANTHROPIC: [(&str, f64, f64); 12] = [
    ("claude-fable-5-1", 10.0, 50.0),
    ("claude-fable-5", 10.0, 50.0),
    ("claude-opus-5-5", 4.0, 20.0),
    ("claude-opus-5", 5.0, 25.0),
    ("claude-opus-4-8", 5.0, 25.0),
    ("claude-opus-4-7", 5.0, 25.0),
    ("claude-opus-4-6", 5.0, 25.0),
    ("claude-sonnet-5-5", 2.0, 10.0),
    ("claude-sonnet-5", 2.0, 10.0),
    ("claude-sonnet-4-6", 3.0, 15.0),
    ("claude-haiku-5-5", 0.10, 0.50),
    ("claude-haiku-4-5", 1.0, 5.0),
];

pub fn builtin_price(kind: AiProviderKind, model: &str) -> Option<AiPrice> {
    if kind != AiProviderKind::Anthropic {
        return None;
    }
    ANTHROPIC.iter().find(|(id, _, _)| *id == model).map(|(_, input, output)| AiPrice {
        input_usd_per_mtok: *input,
        output_usd_per_mtok: *output,
        source: AiPriceSource::Builtin,
        as_of: Some(PRICES_AS_OF.to_string()),
    })
}

pub fn price_for(settings: &Settings, kind: AiProviderKind, model: &str) -> Option<AiPrice> {
    if kind.is_local() {
        return None;
    }
    if let Some(own) = settings.ai_prices.iter().find(|price| price.model == model) {
        return Some(AiPrice { input_usd_per_mtok: own.input_usd_per_mtok, output_usd_per_mtok: own.output_usd_per_mtok, source: AiPriceSource::Own, as_of: None });
    }
    builtin_price(kind, model)
}

pub fn cost_usd(price: &AiPrice, usage: &Usage) -> f64 {
    (usage.input_tokens as f64 * price.input_usd_per_mtok + usage.output_tokens as f64 * price.output_usd_per_mtok) / 1_000_000.0
}

pub fn micros(usd: f64) -> i64 {
    (usd * 1_000_000.0).round() as i64
}

pub fn current_month() -> String {
    chrono::Utc::now().format("%Y-%m").to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::provider::Usage;
    use crate::model::{AiPriceOverride, AiPriceSource, AiProviderKind, Settings};

    #[test]
    fn costs_from_the_dated_table() {
        let price = builtin_price(AiProviderKind::Anthropic, "claude-sonnet-5-5").unwrap();
        assert_eq!((price.input_usd_per_mtok, price.output_usd_per_mtok), (2.0, 10.0));
        assert_eq!(price.source, AiPriceSource::Builtin);
        assert_eq!(price.as_of.as_deref(), Some("2026-10-06"));
        // 12 345 × 2 USD/M + 678 × 10 USD/M = 0.02469 + 0.00678 = 0.03147 USD.
        let cost = cost_usd(&price, &Usage { input_tokens: 12_345, output_tokens: 678 });
        assert_eq!(micros(cost), 31_470);
        let haiku = builtin_price(AiProviderKind::Anthropic, "claude-haiku-5-5").unwrap();
        assert_eq!((haiku.input_usd_per_mtok, haiku.output_usd_per_mtok), (0.10, 0.50));
        assert_eq!(builtin_price(AiProviderKind::Anthropic, "claude-opus-5-5").map(|p| p.input_usd_per_mtok), Some(4.0));
    }

    #[test]
    fn own_prices_win_and_unknown_models_have_none() {
        let mut settings = Settings::default();
        assert!(price_for(&settings, AiProviderKind::Openai, "gpt-5.1").is_none(), "unknown → no estimate, no limit protection");
        assert!(builtin_price(AiProviderKind::Anthropic, "claude-sonnet-5-5-20260101").is_none(), "dated IDs are not guessed");
        assert!(price_for(&settings, AiProviderKind::Ollama, "qwen3:8b").is_none(), "local models cost nothing");
        settings.ai_prices = vec![
            AiPriceOverride { model: "claude-sonnet-5-5".into(), input_usd_per_mtok: 1.0, output_usd_per_mtok: 3.0 },
            AiPriceOverride { model: "gpt-5.1".into(), input_usd_per_mtok: 1.25, output_usd_per_mtok: 10.0 },
        ];
        let own = price_for(&settings, AiProviderKind::Anthropic, "claude-sonnet-5-5").unwrap();
        assert_eq!((own.input_usd_per_mtok, own.source, own.as_of), (1.0, AiPriceSource::Own, None));
        assert_eq!(price_for(&settings, AiProviderKind::Openai, "gpt-5.1").map(|p| p.output_usd_per_mtok), Some(10.0));
        assert!(price_for(&settings, AiProviderKind::Ollama, "gpt-5.1").is_none(), "never a price for local providers");
    }

    #[test]
    fn months_are_utc_year_and_month() {
        let month = current_month();
        assert_eq!(month.len(), 7);
        assert_eq!(&month[4..5], "-");
        assert_eq!(month, chrono::Utc::now().format("%Y-%m").to_string());
    }
}
