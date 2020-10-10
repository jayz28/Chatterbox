.PHONY: help install server debug test coverage clean-coverage tunnel

include .env

help:
	@echo
	@echo "Please use 'make <target>' where <target> is one of"
	@echo "  server    to start the server"
	@echo "  debug     to start the server in debug mode"
	@echo "  test      to run tests"
	@echo "  coverage  to generate and review test coverage reports"
	@echo "  install   to install modules and run migrations"
	@echo

# Install the required NPM modules and run migrations
install:
	@npm update
	@npm install

# Run the server!
server:
ifeq (${MODE},dev)
	@NODE_ENV=development npx nodemon index.js | ./node_modules/.bin/bunyan
else
	@echo "Use PM2 to run in production."
endif

# Debug the server
debug:
ifeq (${MODE},dev)
	@echo "Starting up in debug mode..."
	@NODE_ENV=development node debug index.js
else
	@echo "Cannot debug in production."
endif

# Run all tests, and force exit when done (DB doesn't clean up after itself otherwise)
test:
	@NODE_ENV=test jest --forceExit

# Create test coverage report
coverage: clean-coverage
	@NODE_ENV=test jest --forceExit --coverage
	@open coverage/lcov-report/index.html

clean-coverage:
	@rm -rf coverage

# Symlink to slacksimple folder for development
startslacksimpledev:
	@mv node_modules/slacksimple node_modules/slacksimple-old
	@ln -s ../../slacksimple/ node_modules/slacksimple
	@rm -f .git/hooks/pre-commit
	@cp .pre-commit .git/hooks/pre-commit
	@chmod a+x .git/hooks/pre-commit

# Remove symlink to slacksimple folder
stopslacksimpledev:
	@rm node_modules/slacksimple
	@mv node_modules/slacksimple-old node_modules/slacksimple
	@rm .git/hooks/pre-commit

# Open the tunnel
tunnel:
	@ngrok http -subdomain=cnsdev http://localhost:8080
