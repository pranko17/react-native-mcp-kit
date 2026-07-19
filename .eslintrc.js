module.exports = {
  env: {
    browser: true,
    node: true,
  },
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'eslint-config-prettier',
    'plugin:import/recommended',
    'plugin:react/recommended',
    'plugin:react-hooks/recommended',
    'plugin:prettier/recommended',
  ],
  ignorePatterns: ['node_modules', 'dist'],
  overrides: [
    {
      files: ['*.ts', '*.tsx'],
      parser: '@typescript-eslint/parser',
      parserOptions: {
        ecmaFeatures: {
          jsx: true,
        },
        ecmaVersion: 12,
        project: ['./tsconfig.json'],
        sourceType: 'module',
      },
    },
    {
      files: ['src/server/mcpServer.ts', 'src/server/tools/*.ts'],
      rules: {
        'import/extensions': 'off',
      },
    },
  ],
  parserOptions: {
    ecmaFeatures: {
      jsx: true,
    },
    ecmaVersion: 12,
    sourceType: 'module',
  },
  plugins: [
    '@typescript-eslint',
    'react',
    'react-hooks',
    'typescript-sort-keys',
    'sort-destructure-keys',
    'sort-keys-fix',
  ],
  root: true,
  rules: {
    '@typescript-eslint/consistent-type-imports': [
      'error',
      {
        fixStyle: 'inline-type-imports',
        prefer: 'type-imports',
      },
    ],
    '@typescript-eslint/no-empty-object-type': [
      'error',
      {
        allowInterfaces: 'always',
      },
    ],
    '@typescript-eslint/no-unused-vars': [
      'error',
      {
        args: 'after-used',
        ignoreRestSiblings: true,
        vars: 'all',
      },
    ],
    'arrow-body-style': 'off',
    'import/extensions': [
      'error',
      'ignorePackages',
      {
        js: 'never',
        jsx: 'never',
        ts: 'never',
        tsx: 'never',
      },
    ],
    'import/namespace': 'off',
    'import/no-extraneous-dependencies': [
      'warn',
      {
        devDependencies: true,
        optionalDependencies: true,
        peerDependencies: true,
      },
    ],
    'import/no-unresolved': [
      'error',
      {
        ignore: ['^react$', '^@modelcontextprotocol/', '^node:'],
      },
    ],
    'import/order': [
      'error',
      {
        alphabetize: {
          caseInsensitive: true,
          order: 'asc',
        },
        groups: ['builtin', 'external', 'internal', 'parent', 'sibling', 'index', 'object', 'type'],
        'newlines-between': 'always',
      },
    ],
    'import/prefer-default-export': 'off',
    'no-console': 'off',
    'no-empty-function': 'off',
    'no-restricted-imports': [
      'error',
      {
        patterns: [
          {
            group: ['../*'],
            message: 'Please use absolute path (@/) instead.',
          },
        ],
      },
    ],
    'no-shadow': 'off',
    'no-use-before-define': 'off',
    'no-useless-rename': 'error',
    'object-shorthand': ['error', 'always'],
    'prefer-arrow-callback': 'off',
    'prettier/prettier': [
      'error',
      {
        endOfLine: 'auto',
      },
    ],
    'react/jsx-filename-extension': [
      1,
      {
        extensions: ['.ts', '.tsx'],
      },
    ],
    'react/jsx-no-useless-fragment': 'off',
    'react/jsx-sort-props': [
      'warn',
      {
        callbacksLast: true,
        ignoreCase: false,
        locale: 'auto',
        multiline: 'last',
        noSortAlphabetically: false,
        reservedFirst: true,
        shorthandFirst: true,
        shorthandLast: false,
      },
    ],
    'react/react-in-jsx-scope': 'off',
    'react/require-default-props': 'off',
    'react-hooks/exhaustive-deps': 'warn',
    'sort-destructure-keys/sort-destructure-keys': [
      'warn',
      {
        caseSensitive: true,
      },
    ],
    'sort-keys-fix/sort-keys-fix': [
      'warn',
      'asc',
      {
        caseSensitive: true,
        natural: true,
      },
    ],
    'typescript-sort-keys/interface': [
      'warn',
      'asc',
      {
        caseSensitive: true,
        natural: true,
        requiredFirst: true,
      },
    ],
    'typescript-sort-keys/string-enum': [
      'warn',
      'asc',
      {
        caseSensitive: true,
        natural: true,
      },
    ],
  },
  settings: {
    'import/ignore': ['node_modules'],
    'import/resolver': {
      typescript: {
        project: './tsconfig.json',
      },
    },
    react: {
      version: '19',
    },
  },
};
