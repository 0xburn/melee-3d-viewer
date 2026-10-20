# wasm-viewer.mk: the browser viewer's build of the simulator, read after the
# simulator's own Makefile (nothing in the simulator's tree changes):
#
#   make -f Makefile -f <this file> wasm-viewer MSL_VISUAL_TRACK_BUILD=1 MSL_REPLAY_ARITHMETIC=1 ...
#
# It compiles the same objects as `make wasm` (WASM_CORE_OBJS, the same
# per-file flags) and links them differently: the viewer API's five functions
# exported (api.h msl_viewer_*), no game data packaged (the browser writes the
# player's own files into the module's file system), a file system to write
# them into, and a worker environment.
#
# WASM_OPT: the optimization added after the Makefile's own -O0 -g. Empty
# (the default) is upstream's own Wasm profile, the one its native/Wasm
# parity test checks. "release" mirrors the native release profile
# (Makefile NATIVE_RELEASE_*): -O1, with the fighter and item code and
# quatlib kept at -O0 and the release's -O2/-O3 files at those.

WASM_OPT ?=
WASM_VIEWER_DIR ?= $(WASM_BUILD)/viewer
WASM_VIEWER_MODULE := $(WASM_VIEWER_DIR)/melee-sim.mjs
WASM_VIEWER_INITIAL_MEMORY ?= 268435456
WASM_VIEWER_MAXIMUM_MEMORY ?= 2147483648

ifeq ($(WASM_OPT),release)
WASM_RELEASE_O0_OBJS := \
	$(filter-out $(WASM_OBJ_DIR)/gameplay/melee/ft/ftanim.o,\
		$(filter $(WASM_OBJ_DIR)/gameplay/melee/ft/%,$(WASM_UPSTREAM_OBJS))) \
	$(filter $(WASM_OBJ_DIR)/gameplay/melee/it/%,$(WASM_UPSTREAM_OBJS)) \
	$(WASM_OBJ_DIR)/gameplay/sysdolphin/baselib/quatlib.o
WASM_RELEASE_O2_OBJS := $(WASM_OBJ_DIR)/gameplay/melee/lb/lb_00B0.o $(WASM_OBJ_DIR)/src/runtime/camera.o
WASM_RELEASE_O3_OBJS := $(addprefix $(WASM_OBJ_DIR)/,gameplay/melee/ft/ftanim.o gameplay/melee/lb/lbspdisplay.o \
	gameplay/melee/lb/lbvector.o gameplay/melee/mp/mplib.o gameplay/sysdolphin/baselib/fobj.o \
	gameplay/sysdolphin/baselib/jobj.o src/api.o src/platform/dolphin_mtx.o src/runtime/fighter_pose.o \
	src/runtime/observation.o src/runtime/ppc_sqrt.o src/runtime/relocation.o src/runtime/savestate.o \
	src/runtime/viewer.o src/runtime/wire.o generated/native_dat_layout.o generated/match_reloc_layout.o)
WASM_OPT_FLAGS := -O1 -g0
$(WASM_RELEASE_O0_OBJS): WASM_OPT_FLAGS := -O0 -g0
$(WASM_RELEASE_O2_OBJS): WASM_OPT_FLAGS := -O2 -g0
$(WASM_RELEASE_O3_OBJS): WASM_OPT_FLAGS := -O3 -g0
# (trig and math keep the Makefile's own -O2 and contraction)
$(WASM_OBJ_DIR)/gameplay/MSL/trigf.o $(WASM_OBJ_DIR)/src/runtime/math.o: WASM_OPT_FLAGS := -g0
WASM_CFLAGS = $(CFLAGS) $(HOSTED_LEGACY_CFLAGS) $(WASM_OPT_FLAGS)
endif

WASM_VIEWER_EXPORTS := ["_malloc","_free","_msl_viewer_create","_msl_viewer_destroy","_msl_viewer_step","_msl_viewer_track","_msl_viewer_output"]

.PHONY: wasm-viewer wasm-objects
wasm-objects: $(WASM_CORE_OBJS)
wasm-viewer: $(WASM_VIEWER_MODULE)

# (the objects go in a response file: 528 of them pass Windows' 32K command line)
WASM_VIEWER_RSP := $(WASM_BUILD)/viewer-objs.rsp

$(WASM_VIEWER_MODULE): $(WASM_CORE_OBJS)
	@mkdir -p "$(@D)"
	$(file >$(WASM_VIEWER_RSP),$(WASM_CORE_OBJS))
	"$(EMCC)" -O2 -sSTACK_SIZE=1048576 --no-entry -Wl,--gc-sections @"$(WASM_VIEWER_RSP)" $(LDLIBS) \
		-sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createMeleeSim \
		-sENVIRONMENT=web,worker,node -sALLOW_MEMORY_GROWTH=1 \
		-sINITIAL_MEMORY=$(WASM_VIEWER_INITIAL_MEMORY) -sMAXIMUM_MEMORY=$(WASM_VIEWER_MAXIMUM_MEMORY) \
		-sGROWABLE_ARRAYBUFFERS=0 -sFORCE_FILESYSTEM=1 \
		-sEXPORTED_FUNCTIONS='$(WASM_VIEWER_EXPORTS)' \
		-sEXPORTED_RUNTIME_METHODS='["HEAPU8","FS"]' \
		-o "$@" 2> "$(WASM_VIEWER_DIR)/link-warnings.log" || { cat "$(WASM_VIEWER_DIR)/link-warnings.log" >&2; exit 1; }
