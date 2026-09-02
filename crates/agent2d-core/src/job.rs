use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

#[derive(Debug, Clone, Default)]
pub struct CancellationToken {
    cancelled: Arc<AtomicBool>,
}

impl CancellationToken {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancellation_state_is_shared_between_clones() {
        let first = CancellationToken::new();
        let second = first.clone();
        assert!(!first.is_cancelled());
        second.cancel();
        assert!(first.is_cancelled());
    }
}
