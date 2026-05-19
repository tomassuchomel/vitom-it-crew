// Správa git worktree pro AI agenta.
//
// Princip:
//   – Hlavní repo zůstává nedotčené v repoRoot.
//   – Pro každý task vytvoříme git worktree v ${workDir}/task-${id}
//     s vlastní branchí ${branchPrefix}task-${id} navázanou na origin/main.
//   – Worker pracuje JEN ve své worktree – nikdy ve hlavním checkoutu.
//   – Žádný `git push` v této vrstvě. Push naostro (do feature branche, nikdy
//     na main) přidá až vyšší vrstva s explicitní kontrolou.
//
// Bezpečnost:
//   – Všechny git příkazy spouštíme přes `execFile` s argumenty jako pole
//     (žádný shell, žádný command injection).
//   – Branch name musí projít isAllowedBranch(prefix).
//   – Worktree path musí být uvnitř workDir.
//   – taskId musí být kladné celé číslo.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import { isAllowedBranch } from './safety.js';

const exec = promisify(execFile);

class GitManagerError extends Error {
  constructor(message, { code, stderr } = {}) {
    super(message);
    this.name = 'GitManagerError';
    this.code = code;
    this.stderr = stderr;
  }
}

/**
 * @param {Object} opts
 * @param {string} opts.repoRoot          Cesta k hlavnímu git repu (kde sedí .git/).
 * @param {string} opts.workDir           Kořen pro worktree podle tasků.
 * @param {string} opts.branchPrefix      Povolený prefix branch (např. "claude/").
 * @param {string} [opts.baseBranch="main"] Z jaké branche worktree vychází.
 */
export function createGitManager({ repoRoot, workDir, branchPrefix, baseBranch = 'main' }) {
  if (!repoRoot) throw new Error('GitManager: repoRoot je povinný');
  if (!workDir)  throw new Error('GitManager: workDir je povinný');
  if (!branchPrefix || !branchPrefix.endsWith('/')) {
    throw new Error('GitManager: branchPrefix musí končit "/" (např. "claude/")');
  }

  const assertTaskId = (id) => {
    if (!Number.isInteger(id) || id <= 0) {
      throw new GitManagerError(`taskId musí být kladné celé číslo (got: ${id})`, { code: 'invalid_task_id' });
    }
  };

  const worktreePath = (taskId) => path.join(workDir, `task-${taskId}`);
  const branchName   = (taskId) => `${branchPrefix}task-${taskId}`;

  const git = async (args, cwd = repoRoot) => {
    try {
      const { stdout, stderr } = await exec('git', args, { cwd, maxBuffer: 10 * 1024 * 1024 });
      return { stdout, stderr };
    } catch (err) {
      throw new GitManagerError(
        `git ${args[0]} failed: ${err.message}`,
        { code: 'git_error', stderr: err.stderr?.toString?.() || '' }
      );
    }
  };

  /**
   * Vytvoří worktree + branch pro daný task. Idempotentní jen v omezené míře –
   * pokud worktree už existuje, vyhodí chybu (volající má cleanup zavolat sám).
   */
  async function createWorktree(taskId) {
    assertTaskId(taskId);
    const branch = branchName(taskId);
    if (!isAllowedBranch(branch, branchPrefix)) {
      throw new GitManagerError(`branch "${branch}" neprošla allowlist`, { code: 'branch_not_allowed' });
    }
    const wt = worktreePath(taskId);

    // Worktree path musí ležet uvnitř workDir – paranoidní kontrola
    const resolved = path.resolve(wt);
    const wdResolved = path.resolve(workDir);
    if (!resolved.startsWith(wdResolved + path.sep) && resolved !== wdResolved) {
      throw new GitManagerError('worktree path leží mimo workDir', { code: 'worktree_outside_workdir' });
    }

    // Worktree base – zkusíme origin/baseBranch, kdyby remote chybělo, padne se na local
    const ref = `origin/${baseBranch}`;
    await git(['worktree', 'add', '-b', branch, wt, ref]);
    return { worktreePath: wt, branch };
  }

  /**
   * Odstraní worktree + smaže branch (s --force, předpokládáme že nikdo není
   * checked out tam, kde se to odstraňuje).
   */
  async function cleanupWorktree(taskId) {
    assertTaskId(taskId);
    const wt = worktreePath(taskId);
    const branch = branchName(taskId);

    // Pokud složka neexistuje, je nás úkol hotov (idempotent cleanup)
    try { await fs.access(wt); }
    catch { return { removed: false, reason: 'no_worktree' }; }

    await git(['worktree', 'remove', '--force', wt]);
    // Smaž branch, pokud existuje (může už být smazaná git worktree remove --force)
    try { await git(['branch', '-D', branch]); } catch { /* branch už neexistuje – ok */ }
    return { removed: true };
  }

  /**
   * Vrátí diff worktree branche proti baseBranch (typicky origin/main).
   * Použij např. pro náhled v UI nebo log.
   */
  async function getDiff(taskId) {
    assertTaskId(taskId);
    const wt = worktreePath(taskId);
    const { stdout } = await git(['diff', `origin/${baseBranch}...HEAD`], wt);
    return stdout;
  }

  /**
   * Soupis aktuálních worktree, pro debug / cleanup orphans.
   */
  async function listWorktrees() {
    const { stdout } = await git(['worktree', 'list', '--porcelain']);
    return stdout;
  }

  return { createWorktree, cleanupWorktree, getDiff, listWorktrees };
}

export { GitManagerError };
