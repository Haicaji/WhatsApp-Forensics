use std::ffi::OsString;
use std::io::{self, Write as _};
use std::path::PathBuf;
use std::process::ExitCode;

use waeb_verify::{InvalidReport, VerifyError, verify_directory};

fn main() -> ExitCode {
    match parse_arguments(std::env::args_os().skip(1)) {
        Ok(arguments) => match verify_directory(&arguments.bag, &arguments.trusted_fingerprints) {
            Ok(report) => {
                write_json(&report);
                ExitCode::SUCCESS
            }
            Err(error) => {
                write_json(&InvalidReport::new(error));
                ExitCode::from(1)
            }
        },
        Err(error) => {
            write_json(&InvalidReport::new(error));
            ExitCode::from(2)
        }
    }
}

struct Arguments {
    bag: PathBuf,
    trusted_fingerprints: Vec<String>,
}

fn parse_arguments(arguments: impl Iterator<Item = OsString>) -> Result<Arguments, VerifyError> {
    let mut arguments = arguments.peekable();
    let mut bag = None;
    let mut trusted_fingerprints = Vec::new();
    while let Some(argument) = arguments.next() {
        if argument == "--trusted-fingerprint" {
            let value = arguments
                .next()
                .ok_or_else(|| cli_error("--trusted-fingerprint requires a value"))?;
            let fingerprint = value
                .into_string()
                .map_err(|_| cli_error("trusted fingerprint must be UTF-8"))?;
            if !valid_fingerprint(&fingerprint) {
                return Err(cli_error(
                    "trusted fingerprint must be sha256:<64 lowercase hex>",
                ));
            }
            if !trusted_fingerprints.contains(&fingerprint) {
                trusted_fingerprints.push(fingerprint);
            }
        } else if argument.to_string_lossy().starts_with('-') {
            return Err(cli_error(format!(
                "unknown option: {}",
                argument.to_string_lossy()
            )));
        } else if bag.replace(PathBuf::from(argument)).is_some() {
            return Err(cli_error("exactly one bag directory may be supplied"));
        }
    }
    let bag = bag.ok_or_else(|| {
        cli_error("usage: waeb-verify <bag-directory> [--trusted-fingerprint sha256:<hex>]")
    })?;
    Ok(Arguments {
        bag,
        trusted_fingerprints,
    })
}

fn valid_fingerprint(value: &str) -> bool {
    let Some(digest) = value.strip_prefix("sha256:") else {
        return false;
    };
    digest.len() == 64
        && digest
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}

fn cli_error(message: impl Into<String>) -> VerifyError {
    VerifyError {
        code: "cli_usage",
        message: message.into(),
    }
}

fn write_json(value: &impl serde::Serialize) {
    let stdout = io::stdout();
    let mut handle = stdout.lock();
    if serde_json::to_writer_pretty(&mut handle, value).is_ok() {
        let _ = handle.write_all(b"\n");
    }
}

#[cfg(test)]
mod tests {
    use super::{parse_arguments, valid_fingerprint};
    use std::ffi::OsString;

    #[test]
    fn parses_external_trust_anchor() {
        let fingerprint = format!("sha256:{}", "a".repeat(64));
        let arguments = parse_arguments(
            [
                OsString::from("bag"),
                OsString::from("--trusted-fingerprint"),
                OsString::from(&fingerprint),
            ]
            .into_iter(),
        );
        assert!(arguments.is_ok());
        assert!(valid_fingerprint(&fingerprint));
    }

    #[test]
    fn rejects_uppercase_fingerprint() {
        assert!(!valid_fingerprint(&format!("sha256:{}", "A".repeat(64))));
    }
}
