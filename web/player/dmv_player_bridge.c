#include <stdint.h>
#include <stdio.h>
#include <string.h>

#include "libmoonsound.h"

#define DMV_SAMPLE_RATE 44100

static MSContext *g_ctx = NULL;
static int g_core_loaded = 0;
static char g_error[512];
static char g_rom_path[512];
static char g_waves_path[512];

static void set_error(const char *msg) {
  if (!msg) {
    g_error[0] = '\0';
    return;
  }
  snprintf(g_error, sizeof(g_error), "%s", msg);
}

static void clear_ctx(void) {
  if (g_ctx) {
    ms_destroy(g_ctx);
    g_ctx = NULL;
  }
}

static int reload_core_assets(void) {
  if (!g_ctx || !g_rom_path[0] || !g_waves_path[0]) {
    set_error("MoonSound core asset paths are not set.");
    return 0;
  }
  if (!ms_load_rom_file(g_ctx, g_rom_path)) {
    set_error(ms_get_last_error(g_ctx));
    return 0;
  }
  if (!ms_load_waves_file(g_ctx, g_waves_path)) {
    set_error(ms_get_last_error(g_ctx));
    return 0;
  }
  return 1;
}

int dmv_load_core(const char *rom_path, const char *waves_path) {
  if (!rom_path || !waves_path || !rom_path[0] || !waves_path[0]) {
    set_error("Invalid core asset paths.");
    return 0;
  }

  snprintf(g_rom_path, sizeof(g_rom_path), "%s", rom_path);
  snprintf(g_waves_path, sizeof(g_waves_path), "%s", waves_path);

  clear_ctx();
  g_ctx = ms_create();
  if (!g_ctx) {
    set_error("Failed to allocate MoonSound context.");
    return 0;
  }

  if (!reload_core_assets()) {
    return 0;
  }

  g_core_loaded = 1;
  set_error(NULL);
  return 1;
}

int dmv_prepare_song(const char *mwm_path, const char *mwk_path, int loops) {
  if (!g_core_loaded || !g_ctx) {
    set_error("MoonSound core assets are not loaded.");
    return 0;
  }

  // Recreate context for each song load.
  // ms_stop() frees internal song allocations and libmoonsound load paths can
  // otherwise hit stale/free'd state across repeated prepare/load cycles.
  clear_ctx();
  g_ctx = ms_create();
  if (!g_ctx) {
    set_error("Failed to allocate MoonSound context.");
    return 0;
  }
  if (!reload_core_assets()) {
    return 0;
  }

  if (!ms_load_mwm_file(g_ctx, mwm_path)) {
    set_error(ms_get_last_error(g_ctx));
    return 0;
  }

  if (mwk_path && mwk_path[0] != '\0') {
    if (!ms_load_mwk_file(g_ctx, mwk_path)) {
      set_error(ms_get_last_error(g_ctx));
      return 0;
    }
  }

  if (loops < 0) {
    loops = 0;
  }
  ms_set_loop_count(g_ctx, loops);

  if (!ms_prepare(g_ctx)) {
    set_error(ms_get_last_error(g_ctx));
    return 0;
  }

  set_error(NULL);
  return 1;
}

int dmv_render_pcm(int16_t *out_interleaved, int frames) {
  if (!g_ctx || !out_interleaved || frames <= 0) {
    return 0;
  }
  return (int)ms_render(g_ctx, out_interleaved, (uint32_t)frames);
}

void dmv_stop_song(void) {
  (void)g_ctx;
}

void dmv_shutdown(void) {
  clear_ctx();
  g_core_loaded = 0;
}

int dmv_sample_rate(void) { return DMV_SAMPLE_RATE; }

const char *dmv_last_error(void) {
  if (g_error[0]) {
    return g_error;
  }
  if (g_ctx) {
    const char *msg = ms_get_last_error(g_ctx);
    if (msg && msg[0]) {
      return msg;
    }
  }
  return "";
}
