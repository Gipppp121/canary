.PHONY: install test demo doctor build lint clean

install:
	npm install

test:
	npm test

demo:
	npm run canary -- watch --demo

doctor:
	npm run canary -- doctor --probe

build:
	npm run build

lint:
	npm run typecheck

clean:
	rm -rf dist node_modules .canary
