//! The schema dialect of every AI function and its validator.
//! Allowed: `object`, `array`, `string`, `integer`, `number`, `boolean`, `enum` (of strings) and
//! the union `[T, "null"]`; every object lists all its properties in `required` and has
//! `additionalProperties: false`; no formats, patterns or limits. The same schema goes to the
//! provider (strict structured output) and is checked here again – the provider's promise is not
//! trusted.

use serde_json::{Map, Value};

const BASIC: [&str; 6] = ["object", "array", "string", "integer", "number", "boolean"];
const KEYS: [&str; 7] = ["type", "properties", "required", "additionalProperties", "items", "enum", "description"];

/// Type of a schema node and whether `null` is allowed.
fn node_type<'a>(node: &'a Map<String, Value>, at: &str) -> Result<(&'a str, bool), String> {
    match node.get("type") {
        Some(Value::String(name)) if BASIC.contains(&name.as_str()) => Ok((name.as_str(), false)),
        Some(Value::Array(list)) => {
            let names: Vec<&'a str> = list.iter().filter_map(Value::as_str).collect();
            match names.as_slice() {
                [name, "null"] | ["null", name] if list.len() == 2 && BASIC.contains(name) => Ok((*name, true)),
                _ => Err(format!("{at}: a type list must be [T, \"null\"]")),
            }
        }
        Some(other) => Err(format!("{at}: unknown type {other}")),
        None => Err(format!("{at}: \"type\" is missing")),
    }
}

/// Is `schema` in the dialect? The error names the place (`$.steps[]`).
pub fn check_dialect(schema: &Value) -> Result<(), String> {
    check_node(schema, "$")
}

fn check_node(node: &Value, at: &str) -> Result<(), String> {
    let Value::Object(map) = node else {
        return Err(format!("{at}: a schema node must be an object"));
    };
    if let Some(key) = map.keys().find(|key| !KEYS.contains(&key.as_str())) {
        return Err(format!("{at}: \"{key}\" is not allowed"));
    }
    let (kind, _) = node_type(map, at)?;
    if let Some(values) = map.get("enum") {
        let strings = values.as_array().is_some_and(|list| !list.is_empty() && list.iter().all(Value::is_string));
        if kind != "string" || !strings {
            return Err(format!("{at}: \"enum\" needs type string and a list of strings"));
        }
    }
    match kind {
        "object" => {
            let properties = map.get("properties").and_then(Value::as_object).ok_or_else(|| format!("{at}: an object needs \"properties\""))?;
            if map.get("additionalProperties") != Some(&Value::Bool(false)) {
                return Err(format!("{at}: \"additionalProperties\" must be false"));
            }
            let mut required: Vec<&str> = map.get("required").and_then(Value::as_array).map(|list| list.iter().filter_map(Value::as_str).collect()).unwrap_or_default();
            let mut names: Vec<&str> = properties.keys().map(String::as_str).collect();
            required.sort_unstable();
            names.sort_unstable();
            if required != names {
                return Err(format!("{at}: \"required\" must list every property exactly once"));
            }
            for (name, child) in properties {
                check_node(child, &format!("{at}.{name}"))?;
            }
            Ok(())
        }
        "array" => {
            let items = map.get("items").ok_or_else(|| format!("{at}: an array needs \"items\""))?;
            check_node(items, &format!("{at}[]"))
        }
        _ => {
            if ["properties", "items", "required", "additionalProperties"].iter().any(|key| map.contains_key(*key)) {
                return Err(format!("{at}: only objects and arrays have properties or items"));
            }
            Ok(())
        }
    }
}

/// Does `value` match `schema` (which must be in the dialect)? The error names the place.
pub fn validate(schema: &Value, value: &Value) -> Result<(), String> {
    check_value(schema, value, "$")
}

fn check_value(schema: &Value, value: &Value, at: &str) -> Result<(), String> {
    let Value::Object(map) = schema else {
        return Err(format!("{at}: invalid schema"));
    };
    let (kind, nullable) = node_type(map, at)?;
    if value.is_null() {
        return if nullable { Ok(()) } else { Err(format!("{at}: must not be null")) };
    }
    match kind {
        "string" => {
            let Some(text) = value.as_str() else {
                return Err(format!("{at}: expected text"));
            };
            if let Some(allowed) = map.get("enum").and_then(Value::as_array) {
                if !allowed.iter().any(|item| item.as_str() == Some(text)) {
                    return Err(format!("{at}: “{}” is not one of the allowed values", crate::util::truncate_str(text, 40)));
                }
            }
            Ok(())
        }
        "integer" => {
            if value.is_i64() || value.is_u64() {
                Ok(())
            } else {
                Err(format!("{at}: expected a whole number"))
            }
        }
        "number" => {
            if value.is_number() {
                Ok(())
            } else {
                Err(format!("{at}: expected a number"))
            }
        }
        "boolean" => {
            if value.is_boolean() {
                Ok(())
            } else {
                Err(format!("{at}: expected true or false"))
            }
        }
        "array" => {
            let Some(list) = value.as_array() else {
                return Err(format!("{at}: expected a list"));
            };
            let items = map.get("items").ok_or_else(|| format!("{at}: invalid schema"))?;
            for (index, item) in list.iter().enumerate() {
                check_value(items, item, &format!("{at}[{index}]"))?;
            }
            Ok(())
        }
        _ => {
            let Some(object) = value.as_object() else {
                return Err(format!("{at}: expected an object"));
            };
            let properties = map.get("properties").and_then(Value::as_object).ok_or_else(|| format!("{at}: invalid schema"))?;
            if let Some(extra) = object.keys().find(|key| !properties.contains_key(*key)) {
                return Err(format!("{at}: unexpected field “{}”", crate::util::truncate_str(extra, 40)));
            }
            for (name, child) in properties {
                let Some(field) = object.get(name) else {
                    return Err(format!("{at}: field “{name}” is missing"));
                };
                check_value(child, field, &format!("{at}.{name}"))?;
            }
            Ok(())
        }
    }
}

/// The answer text as JSON; a surrounding Markdown code fence is tolerated (models in prompt mode).
pub fn parse_answer(text: &str) -> Result<Value, String> {
    let mut body = text.trim();
    if let Some(rest) = body.strip_prefix("```") {
        let rest = rest.strip_prefix("json").unwrap_or(rest);
        body = rest.strip_suffix("```").unwrap_or(rest).trim();
    }
    serde_json::from_str(body).map_err(|_| "the answer is not valid JSON".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn commit_schema() -> serde_json::Value {
        json!({
            "type": "object",
            "properties": { "summary": { "type": "string" }, "body": { "type": ["string", "null"] } },
            "required": ["summary", "body"],
            "additionalProperties": false
        })
    }

    fn plan_schema() -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "steps": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "command": { "type": "string", "enum": ["branchCreate", "fetch"] },
                            "count": { "type": "integer" },
                            "weight": { "type": "number" },
                            "confirm": { "type": "boolean" }
                        },
                        "required": ["command", "count", "weight", "confirm"],
                        "additionalProperties": false
                    }
                }
            },
            "required": ["steps"],
            "additionalProperties": false
        })
    }

    #[test]
    fn function_schemas_are_in_the_dialect() {
        assert_eq!(check_dialect(&commit_schema()), Ok(()));
        assert_eq!(check_dialect(&plan_schema()), Ok(()));
    }

    #[test]
    fn the_dialect_rejects_what_strict_providers_reject() {
        let cases = [
            (json!({"type": "string", "format": "date-time"}), "\"format\" is not allowed"),
            (json!({"type": "string", "pattern": "^a"}), "\"pattern\" is not allowed"),
            (json!({"type": "object", "properties": {"a": {"type": "string"}}, "required": ["a"]}), "additionalProperties"),
            (json!({"type": "object", "properties": {"a": {"type": "string"}, "b": {"type": "string"}}, "required": ["a"], "additionalProperties": false}), "every property"),
            (json!({"type": ["string", "integer"]}), "[T, \"null\"]"),
            (json!({"type": "array"}), "needs \"items\""),
            (json!({"type": "integer", "enum": ["a"]}), "enum"),
            (json!({"properties": {}}), "\"type\" is missing"),
        ];
        for (schema, wanted) in cases {
            let error = check_dialect(&schema).expect_err(&schema.to_string());
            assert!(error.contains(wanted), "{schema}: {error}");
        }
    }

    #[test]
    fn values_are_checked_strictly() {
        let schema = commit_schema();
        assert_eq!(validate(&schema, &json!({"summary": "Fix login", "body": null})), Ok(()));
        assert_eq!(validate(&schema, &json!({"summary": "Fix login", "body": "Details"})), Ok(()));
        for (value, wanted) in [
            (json!({"summary": "Fix"}), "field “body” is missing"),
            (json!({"summary": "Fix", "body": null, "extra": 1}), "unexpected field “extra”"),
            (json!({"summary": 5, "body": null}), "$.summary: expected text"),
            (json!({"summary": null, "body": null}), "$.summary: must not be null"),
            (json!(["Fix"]), "$: expected an object"),
        ] {
            let error = validate(&schema, &value).expect_err(&value.to_string());
            assert!(error.contains(wanted), "{value}: {error}");
        }
    }

    #[test]
    fn nested_errors_name_the_path() {
        let schema = plan_schema();
        let ok = json!({"steps": [{"command": "fetch", "count": 2, "weight": 0.5, "confirm": true}]});
        assert_eq!(validate(&schema, &ok), Ok(()));
        let injected = json!({"steps": [
            {"command": "fetch", "count": 1, "weight": 1, "confirm": false},
            {"command": "push --force", "count": 1, "weight": 1, "confirm": false}
        ]});
        let error = validate(&schema, &injected).unwrap_err();
        assert!(error.starts_with("$.steps[1].command:"), "{error}");
        let fraction = json!({"steps": [{"command": "fetch", "count": 1.5, "weight": 1, "confirm": false}]});
        assert!(validate(&schema, &fraction).unwrap_err().contains("$.steps[0].count: expected a whole number"));
    }

    #[test]
    fn answers_are_read_with_or_without_a_code_fence() {
        assert_eq!(parse_answer("{\"a\": 1}"), Ok(json!({"a": 1})));
        assert_eq!(parse_answer("```json\n{\"a\": 1}\n```"), Ok(json!({"a": 1})));
        assert_eq!(parse_answer("  ```\n{\"a\": 1}\n```  "), Ok(json!({"a": 1})));
        assert!(parse_answer("Sure! Here you go: {").unwrap_err().contains("not valid JSON"));
    }
}
