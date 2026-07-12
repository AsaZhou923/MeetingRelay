use std::io::{self, Write};

use meetingrelay_model_worker_sherpa_native::locked_candidate_builder_input_json_bytes;

fn main() -> io::Result<()> {
    io::stdout()
        .lock()
        .write_all(&locked_candidate_builder_input_json_bytes())
}
