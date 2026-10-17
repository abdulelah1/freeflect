//! Every user, shortcut or agent action flows through the [`ActionBus`]. It is
//! the audit log, the source for macro replay and, later, the MCP surface.

use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;

use crate::{DeviceId, InputEvent};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ActionSource {
    User,
    Shortcut,
    Agent,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Action {
    Input { event: InputEvent },
    Screenshot,
    PushFile { local: String, remote: String },
    ClipboardSet { text_len: usize },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActionRecord {
    pub seq: u64,
    pub at_ms: u64,
    pub device: DeviceId,
    pub source: ActionSource,
    pub action: Action,
}

pub struct ActionBus {
    tx: broadcast::Sender<ActionRecord>,
    seq: std::sync::atomic::AtomicU64,
}

impl ActionBus {
    pub fn new(capacity: usize) -> Self {
        let (tx, _) = broadcast::channel(capacity);
        Self { tx, seq: Default::default() }
    }

    pub fn publish(&self, device: DeviceId, source: ActionSource, action: Action) -> ActionRecord {
        let seq = self.seq.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let at_ms = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
        let record = ActionRecord { seq, at_ms, device, source, action };
        // No subscribers is fine; the record is still returned to the caller.
        let _ = self.tx.send(record.clone());
        record
    }

    pub fn subscribe(&self) -> broadcast::Receiver<ActionRecord> {
        self.tx.subscribe()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn publishes_in_sequence_to_subscribers() {
        let bus = ActionBus::new(16);
        let mut rx = bus.subscribe();
        let dev = DeviceId("emulator-5554".into());
        bus.publish(dev.clone(), ActionSource::User, Action::Screenshot);
        bus.publish(dev, ActionSource::Agent, Action::ClipboardSet { text_len: 3 });

        let a = rx.recv().await.unwrap();
        let b = rx.recv().await.unwrap();
        assert_eq!((a.seq, b.seq), (0, 1));
        assert_eq!(b.source, ActionSource::Agent);
    }
}
