VERSION := $(shell cat VERSION)

module.tar.gz: run.sh requirements.txt meta.json src/*.py src/variable_tools/*.py
	tar czf $@ $^

.PHONY: test
test:
	.venv/bin/pip install -q -r requirements-dev.txt
	.venv/bin/pytest

.PHONY: upload
upload: test module.tar.gz
	viam module upload --version=$(VERSION) --platform=linux/any module.tar.gz
