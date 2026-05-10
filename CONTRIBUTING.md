# Contributing to grafio-mongo

Thank you for your interest in contributing to grafio-mongo! This document provides guidelines and instructions for contributing to the MongoDB storage backend for [grafio](https://github.com/witspry/grafio).

## Contributor License Agreement (CLA)

By submitting contributions to grafio, you grant **Satya Jugran** (the project owner) a perpetual, irrevocable, worldwide, non-exclusive, royalty-free license to use, reproduce, modify, distribute, and display your contributions for any purpose, including commercial use, under the terms of the GNU General Public License v3.0 (GPL-3.0).

As the copyright owner and project maintainer, I retain full commercial rights to all code in this repository. Contributors acknowledge that their contributions will be licensed under GPL-3.0 and agree that such licensing benefits the project while preserving my rights as the copyright holder.

This CLA ensures that contributions are submitted under GPL-3.0 licensing terms and grants me explicit rights to use contributed code in commercial projects without requiring additional approval from contributors.

## Getting Started

1. **Fork the repository** on GitHub
2. **Clone your fork** locally:
   ```bash
   git clone https://github.com/satya-jugran/grafio-mongo.git
   cd grafio-mongo
   ```
3. **Install dependencies**:
   ```bash
   npm install
   ```

## Development Workflow

### Prerequisites

- Node.js >= 18
- npm >= 9

### Building

```bash
npm run build
```

### Running Tests

```bash
# Run all tests
npm test

# Run tests in watch mode
npm run test:watch

# Run tests with coverage
npm run test:coverage

# Run performance benchmarks
npm run perf
```

### Code Style

- Use TypeScript for all new code
- Follow the existing code style (2-space indentation)
- Run `npm run build` before committing to ensure TypeScript compiles without errors

## Project Structure

```
grafio-mongo/
├── src/                        # Source code
│   ├── index.ts                # Main exports
│   ├── MongoGraphFactory.ts    # Factory for creating Graph instances with MongoDB backend
│   └── MongoStorageProvider.ts # MongoDB storage provider implementing IStorageProvider
├── tests/                      # Test files
│   ├── graph/                  # Graph operation tests with MongoDB backend
│   ├── storage/                # Storage provider tests
│   ├── perf/                   # Performance benchmarks
│   └── *.test.ts               # Integration tests
├── CHANGELOG.md                # Version history
└── CODE_OF_CONDUCT.md          # Community guidelines
```

## Making Changes

1. **Create a branch** for your changes:
   ```bash
   git checkout -b feature/your-feature-name
   # or
   git checkout -b fix/your-bug-fix
   ```

2. **Make your changes** following the code style guidelines

3. **Add tests** for new functionality (see [`tests/`](tests/))

4. **Ensure all tests pass**:
   ```bash
   npm test
   ```

5. **Commit your changes** with a clear message:
   ```bash
   git commit -m "feat: add new feature description"
   ```

## Commit Message Format

Use conventional commit format:
- `feat:` for new features
- `fix:` for bug fixes
- `docs:` for documentation changes
- `test:` for test additions/changes
- `refactor:` for code refactoring
- `perf:` for performance improvements

## Pull Request Process

1. Update documentation if needed
2. Add tests for any new functionality
3. Ensure all tests pass
4. Update the [CHANGELOG.md](CHANGELOG.md) if applicable
5. Submit a pull request with a clear description of the changes

## Code of Conduct

Please read our [Code of Conduct](./CODE_OF_CONDUCT.md) before contributing to help keep our community welcoming and inclusive.

## Questions?

Feel free to open an issue on GitHub for questions about contributing.