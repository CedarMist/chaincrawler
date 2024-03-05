ROOT_DIR := $(dir $(realpath $(lastword $(MAKEFILE_LIST))))
BUILD_DIR=$(ROOT_DIR)build
CONTRACTS_DIR=$(ROOT_DIR)contracts

COMMON_ROOT_DIR:=$(dir $(realpath $(lastword $(MAKEFILE_LIST))))

PYTHON ?= python3

SOLC_PLAT?=linux-amd64
SOLC_VER?=v0.8.23
SOLC_COMMIT?=f704f362
SOLC_URL?=https://binaries.soliditylang.org/$(SOLC_PLAT)/solc-$(SOLC_PLAT)-$(SOLC_VER)%2Bcommit.$(SOLC_COMMIT)
SOLC?=$(COMMON_ROOT_DIR)bin/solc
SOLC_OPTS=--metadata --base-path $(COMMON_ROOT_DIR) --include-path $(COMMON_ROOT_DIR)interfaces --metadata-literal --abi --bin --overwrite --optimize --via-ir # --optimize-runs 4294967295

all: $(BUILD_DIR)/HelloWorld.bin
	pnpm tsc
	node --loader ts-node/esm src/index.ts

$(SOLC):
	mkdir -p "$(dir $(SOLC))"
	wget --quiet -O "$@" "$(SOLC_URL)"
	chmod 755 "$@"

build:
	pnpm build

clean:
	rm -rf lib build

veryclean: clean
	rm -rf node_modules


$(BUILD_DIR)/HelloWorld.bin: $(SOLC) $(wildcard $(CONTRACTS_DIR)/*.sol $(CONTRACTS_DIR)/lib/*.sol)
	rm -rf "$(dir $@)"
	mkdir -p "$(dir $@)"
	$(SOLC) -o "$(dir $@)" $(SOLC_OPTS) $(wildcard $(CONTRACTS_DIR)/*.sol)
	#find "$(dir $@)" -name '*.bin' -size 0 | xargs rm  # Remove empty .bin files
