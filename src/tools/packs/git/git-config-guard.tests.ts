import { describe, expect, it } from 'vitest';
import { executingKeys, unoverridableKeys } from './git-config-guard.js';

describe('executingKeys', () => {
  it('finds every key whose value is a program git may run', () => {
    const keys = [
      'filter.lfs.clean', 'filter.lfs.smudge', 'filter.lfs.process', 'diff.x.textconv', 'diff.x.command', 'merge.x.driver', 'core.pager', 'pager.log',
      'core.editor', 'sequence.editor', 'core.sshCommand', 'core.fsmonitor', 'core.hooksPath', 'gpg.program', 'gpg.ssh.program', 'credential.helper',
      'gpg.ssh.defaultKeyCommand', 'mergetool.x.cmd', 'difftool.x.cmd', 'trailer.sign.cmd', 'trailer.sign.command', 'interactive.diffFilter',
      'sendemail.sendmailCmd', 'hook.lint.command', 'uploadpack.packObjectsHook', 'core.alternateRefsCommand', 'diff.external', 'core.askPass',
    ];
    expect(executingKeys([...keys, 'user.name', 'core.autocrlf', 'remote.origin.url', 'filter.lfs.required'])).toEqual(keys);
  });
});

describe('unoverridableKeys', () => {
  it('names the keys a -c override cannot reach: "=" or a line break in the name', () => {
    expect(unoverridableKeys(['filter.ev=il.clean', 'filter.a\nb.clean', 'filter.plain.clean', 'filter.a b.clean'])).toEqual(['filter.ev=il.clean', 'filter.a\nb.clean']);
  });
});
