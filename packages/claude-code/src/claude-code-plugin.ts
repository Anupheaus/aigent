import { definePlugin } from '@anupheaus/aigent';
import type { Plugin } from '@anupheaus/aigent';
import { claudeCode } from './claude-code-provider.js';
import type { ClaudeCodeOptions } from './claude-code-provider.js';
import { PACKAGE_VERSION } from './version.js';

/** `createAigent({ plugins: [claudeCodePlugin()] })`: the `claude-code` provider as a one-line plugin. Personal use only. */
export function claudeCodePlugin(options: ClaudeCodeOptions = {}): Plugin {
  return definePlugin({ name: 'claude-code', version: PACKAGE_VERSION, providers: [claudeCode(options)] });
}
