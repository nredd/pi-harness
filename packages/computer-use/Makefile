.PHONY: bridge bridge-all signing-cert

bridge:  ## Build both macOS architectures for dev bundles and packed contracts; no-op elsewhere
	@if [ "$$(uname -s)" = Darwin ]; then $(MAKE) bridge-all; else printf '%s\n' 'NOT RUN macOS bridge build: requires macOS'; fi

bridge-all:  ## Build both macOS architectures for the published payload
	node scripts/build-native.mjs --arch arm64
	node scripts/build-native.mjs --arch x64

signing-cert:  ## Create the local self-signed identity files; OUTPUT_DIR defaults to signing
	node scripts/make-signing-cert.mjs $(if $(OUTPUT_DIR),"$(OUTPUT_DIR)")
