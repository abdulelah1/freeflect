use thiserror::Error;

/// Errors carry a stable `code()` so the UI can map them to plain-language
/// help articles in the Connection Doctor.
#[derive(Debug, Error)]
pub enum Error {
    #[error("device not found: {0}")]
    DeviceNotFound(String),
    #[error("device is not authorized; accept the prompt on the phone")]
    Unauthorized,
    #[error("feature not supported on this device or connection: {0}")]
    Unsupported(&'static str),
    #[error("protocol error: {0}")]
    Protocol(String),
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

impl Error {
    pub fn code(&self) -> &'static str {
        match self {
            Error::DeviceNotFound(_) => "device_not_found",
            Error::Unauthorized => "device_unauthorized",
            Error::Unsupported(_) => "unsupported",
            Error::Protocol(_) => "protocol",
            Error::Io(_) => "io",
        }
    }
}

pub type Result<T> = std::result::Result<T, Error>;
