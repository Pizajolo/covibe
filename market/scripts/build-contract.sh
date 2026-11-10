#!/usr/bin/env bash
# Build the market contract and copy the wasm to market/contract/res/.
# Needs Rust with the wasm target: rustup target add wasm32-unknown-unknown
set -euo pipefail
cd "$(dirname "$0")/../contract"
cargo build --target wasm32-unknown-unknown --release
mkdir -p res
cp target/wasm32-unknown-unknown/release/covibe_market.wasm res/covibe_market.wasm
ls -l res/covibe_market.wasm
