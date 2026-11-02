VERSION := $(shell cat VERSION)

# Build the React/Vite scope into apps/variable-tools-scope/. vite.config.ts
# emits there and bases assets relatively. node_modules is restored on demand.
.PHONY: webapp
webapp:
	cd webapp && (test -d node_modules || npm install) && npx vite build

# Tarball includes the Python module + the static webapp under apps/.
# The whole apps/ tree ships so future apps can be added without
# touching this rule.
module.tar.gz: webapp run.sh requirements.txt meta.json src/*.py src/variable_tools/*.py
	tar --exclude='__pycache__' --exclude='*.pyc' -czf $@ run.sh requirements.txt meta.json src apps

.PHONY: test
test:
	.venv/bin/pip install -q -r requirements-dev.txt
	.venv/bin/pytest

# Fixes lint and formatting in place; CI runs the same checks without fixing.
.PHONY: lint
lint:
	.venv/bin/pip install -q -r requirements-dev.txt
	.venv/bin/ruff check --fix .
	.venv/bin/ruff format .
	npx --yes prettier@3.9.10 --write webapp/src

.PHONY: upload
upload: test module.tar.gz
	viam module upload --version=$(VERSION) --platform=linux/any module.tar.gz
