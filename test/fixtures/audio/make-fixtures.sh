#!/usr/bin/env bash
# 用 ffmpeg 生成 0.8s 正弦小文件（生成后提交入库；CI 不需要 ffmpeg）。
# 本机生成一次即可：bash make-fixtures.sh
set -euo pipefail
cd "$(dirname "$0")"

gen() {
  local fmt="$1"
  shift
  ffmpeg -y -loglevel error -f lavfi -i "sine=frequency=440:duration=0.8" -c:a "$@" "sine.$fmt"
}

gen mp3 libmp3lame -b:a 64k
gen flac flac
gen wav pcm_s16le -ar 8000
gen ogg libvorbis -q:a 3
gen m4a aac -b:a 64k
