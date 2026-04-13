import tseslint from 'typescript-eslint'
import reactPlugin from 'eslint-plugin-react'
import eslintConfigPrettier from 'eslint-config-prettier'

export default tseslint.config(
  {
    ignores: [
      'dist/',
      'public/',
      'coverage/',
      'node_modules/',
      'webpack.config.js',
      'eslint.config.mjs',
      'jest.config.js',
    ],
  },
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    files: ['**/*.tsx'],
    plugins: { react: reactPlugin },
    settings: { react: { version: 'detect' } },
    rules: {
      ...reactPlugin.configs.recommended.rules,
      'react/react-in-jsx-scope': 'off',
    },
  },
  {
    files: ['test/**/*.ts', 'test/**/*.tsx'],
    rules: {
      // jest mock functions bind 'this' non-standardly (e.g. mockReturnValue)
      '@typescript-eslint/unbound-method': 'off',
      // mock.calls entries are implicitly typed as any[]
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
    },
  },
  eslintConfigPrettier,
)
