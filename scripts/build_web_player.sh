#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LIB_DIR_DEFAULT_1="${ROOT_DIR}/modules/libmoonsound"
LIB_DIR_DEFAULT_2="${ROOT_DIR}/libmoonsound"
LIB_DIR_DEFAULT_3="${ROOT_DIR}/../libmoonsound"
LIB_DIR="${LIBMOONSOUND_DIR:-}"
if [[ -z "${LIB_DIR}" ]]; then
  if [[ -d "${LIB_DIR_DEFAULT_1}" ]]; then
    LIB_DIR="${LIB_DIR_DEFAULT_1}"
  elif [[ -d "${LIB_DIR_DEFAULT_2}" ]]; then
    LIB_DIR="${LIB_DIR_DEFAULT_2}"
  else
    LIB_DIR="${LIB_DIR_DEFAULT_3}"
  fi
fi
BUILD_DIR="${ROOT_DIR}/build-emscripten-libmoonsound"
OUT_DIR="${ROOT_DIR}/web/player"
ASSETS_DIR="${ROOT_DIR}/web/assets"
ROM_DEFAULT_1="${LIB_DIR}/yrw801.rom"
ROM_DEFAULT_2="${ROOT_DIR}/../libmoonsound/yrw801.rom"
ROM_PATH="${MOONSOUND_ROM_PATH:-}"
if [[ -z "${ROM_PATH}" ]]; then
  if [[ -f "${ROM_DEFAULT_1}" ]]; then
    ROM_PATH="${ROM_DEFAULT_1}"
  else
    ROM_PATH="${ROM_DEFAULT_2}"
  fi
fi
WAVES_PATH="${MOONSOUND_WAVES_PATH:-${LIB_DIR}/waves.dat}"

if [[ ! -d "${LIB_DIR}" ]]; then
  echo "libmoonsound directory not found: ${LIB_DIR}" >&2
  echo "Set LIBMOONSOUND_DIR or add submodule at modules/libmoonsound." >&2
  exit 1
fi
if [[ ! -f "${ROM_PATH}" ]]; then
  echo "YRW801 ROM not found: ${ROM_PATH}" >&2
  echo "Set MOONSOUND_ROM_PATH to a valid yrw801.rom path." >&2
  exit 1
fi
if [[ ! -f "${WAVES_PATH}" ]]; then
  echo "waves.dat not found: ${WAVES_PATH}" >&2
  echo "Set MOONSOUND_WAVES_PATH to a valid waves.dat path." >&2
  exit 1
fi

mkdir -p "${OUT_DIR}" "${ASSETS_DIR}"

emcmake cmake -S "${LIB_DIR}" -B "${BUILD_DIR}" -DCMAKE_BUILD_TYPE=Release
cmake --build "${BUILD_DIR}" -j

emcc -O3 \
  "${ROOT_DIR}/web/player/dmv_player_bridge.c" \
  "${BUILD_DIR}/libmoonsound.a" \
  -I"${LIB_DIR}/src" \
  -sMODULARIZE=1 \
  -sEXPORT_ES6=1 \
  -sALLOW_MEMORY_GROWTH=1 \
  -sFORCE_FILESYSTEM=1 \
  -sENVIRONMENT=web \
  -sEXPORTED_FUNCTIONS="['_malloc','_free','_dmv_load_core','_dmv_prepare_song','_dmv_render_pcm','_dmv_stop_song','_dmv_shutdown','_dmv_sample_rate','_dmv_last_error']" \
  -sEXPORTED_RUNTIME_METHODS="['ccall','cwrap','FS','HEAP8','HEAP16','HEAPU8']" \
  -o "${OUT_DIR}/moonsound.js"

cp -f "${ROM_PATH}" "${ASSETS_DIR}/yrw801.rom"
cp -f "${WAVES_PATH}" "${ASSETS_DIR}/waves.dat"

echo "Built web player in ${OUT_DIR}"
