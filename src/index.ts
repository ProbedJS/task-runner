/* eslint-disable @typescript-eslint/no-non-null-assertion */
/**
 * Copyright 2021 Francois Chabot
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import logUpdate from 'log-update';
import chalk from 'chalk';
import stripAnsi from 'strip-ansi';

import { AsyncLocalStorage } from 'async_hooks';

export type Status = '...' | 'done' | 'skip' | 'warn' | 'fail';

const currentTask = new AsyncLocalStorage<ITask>();

let currentRunner: Runner | undefined = undefined;

const statusStrength: Record<Status, number> = {
  '...': 0,

  done: 1,
  warn: 2,
  fail: 3,
  skip: 4,
};

const statusText = {
  '...': '....',
  done: chalk.green('Done'),
  skip: chalk.yellow('Skip'),
  warn: chalk.ansi256(214)('Warn'),
  fail: chalk.red('Fail'),
};

/** The length of the common prefix of two strings. */
const commonLen = (a: string, b: string): number => {
  const cmpLen = Math.min(a.length, b.length);
  let result = 0;
  for (result = 0; result < cmpLen; ++result) {
    if (a[result] !== b[result]) break;
  }
  return result;
};

const combineStrings = (a: string, b: string, count: number) => {
  return `${a.slice(0, commonLen(a, b))} … [${count}]`;
};

interface ITask {
  lineLength(depth: number): number;
  status: Status;
  render(depth: number, lineLength: number): string;
  printLogs(): void;
  addMessage(msg: string): void;
  addLog(log: string): void;
  update(): void;

  wait(): Promise<void>;
  _owner: Runner;
  _subTasks: ITask[];
}

const performTask = async <T>(task: () => Promise<T>, owner: Task<T>) => {
  try {
    const result = await currentTask.run(owner, task);

    await Promise.all(owner._subTasks.map((t) => t.wait()));

    owner.status = 'done';

    owner._owner.requestRerender();
    return result;
  } catch (e) {
    owner.status = 'fail';
    owner.addMessage(e.message);

    owner._owner.requestRerender();
    throw e;
  }
};

export class Task<T> implements ITask {
  _owner: Runner;
  _description: string;
  _status: Status = '...';
  _subTasks: ITask[] = [];
  _logs: string[] = [];

  _message = '';
  _msgCount = 0;

  _completion: Promise<T>;

  constructor(description: string, task: () => Promise<T>, owner: Runner) {
    this._owner = owner;
    this._description = description;

    this._completion = performTask(task, this);
  }

  get status(): Status {
    return this._status;
  }

  set status(status: Status) {
    const currentStr = statusStrength[this.status];
    const incomingStr = statusStrength[status];

    if (incomingStr > currentStr) {
      this._status = status;
      this._owner.requestRerender();
    }
  }

  addMessage(msg: string): void {
    const stripped = stripAnsi(msg);
    this._msgCount += 1;
    if (this._message.length === 0) {
      this._message = stripped;
      return;
    }

    this._message = combineStrings(this._message, stripped, this._msgCount);
    this._owner.requestRerender();
  }

  addLog(log: string): void {
    this._logs.push(log);
  }

  update(): void {
    if (this._subTasks.length > 0) {
      if (this._subTasks.some((t) => t.status === 'fail')) {
        this.status = 'fail';
      } else if (this._subTasks.some((t) => t.status === 'warn')) {
        this.status = 'warn';
      } else if (!this._subTasks.some((t) => t.status === '...')) {
        this.status = 'done';
      }
    }
  }

  lineLength(depth: number): number {
    return this._subTasks.reduce(
      (previous, task) => Math.max(previous, task.lineLength(depth + 1)),
      stripAnsi(this._description).length + 2 * depth
    );
  }

  render(depth: number, lineLength: number): string {
    const pad = ' '.repeat(depth * 2);
    const postPad = '| '.repeat(depth);
    let line =
      `${pad}${this._description}`.padEnd(lineLength) +
      `  ${postPad}[${statusText[this.status]}]`;

    if (this._message.length > 0) {
      line += ` - ${this._message}`;
    }

    const available = process.stdout.columns || 80;

    const visualLength = stripAnsi(line).length;
    const ansiCount = line.length - visualLength;

    if (visualLength > available) {
      line = line.slice(0, available + ansiCount - 2) + ' …';
    }

    return [
      line,
      ...this._subTasks.map((t) => t.render(depth + 1, lineLength)),
    ].join('\n');
  }

  printLogs(): void {
    if (this._logs.length > 0) {
      const available = process.stdout.columns || 80;
      const header = `###### ${chalk.cyan(this._description)} : ${
        this._logs.length
      } ######`;

      const padding = available - stripAnsi(header).length;
      console.log(`\n${' '.repeat(padding / 2)}${header}`);
      console.log();
      for (const l of this._logs) {
        console.log(l);
      }
    }

    for (const t of this._subTasks) {
      t.printLogs();
    }
  }

  async wait(): Promise<void> {
    // We need to wait on the main task being done first, because it might
    // queue subtasks.
    await this._completion;
    await Promise.all([...this._subTasks.map((t) => t.wait())]);
  }
}

export const run = async <T>(
  description: string,
  inTask: () => Promise<T>
): Promise<T> => {
  const current = currentTask.getStore();
  if (!current) {
    if (!currentRunner) {
      currentRunner = new Runner();
    }

    const taskObj = new Task(description, inTask, currentRunner);
    currentRunner._roots.push(taskObj);

    try {
      const result = taskObj._completion;
      await result;
      return result;
    } finally {
      currentRunner.rootDone();
    }
  } else {
    const entry = new Task(description, inTask, current._owner);
    current._subTasks.push(entry);
    current._owner.requestRerender();

    return entry._completion;
  }
};

export const runOptional = async <T>(
  description: string,
  inTask: () => Promise<T>
): Promise<T | undefined> => {
  return run<T | undefined>(description, async () => {
    try {
      return await inTask();
    } catch (e) {
      setMessage(e.message);
      setStatus('skip');
    }
  });
};

export const setMessage = (msg: string): void => {
  const current = currentTask.getStore();
  if (current) {
    current.addMessage(msg);
  }
};

export const setStatus = (stat: Status): void => {
  const current = currentTask.getStore();
  if (current) {
    current.status = stat;
  }
};

class Runner {
  _terminatedRoots = 0;
  _backend: logUpdate.LogUpdate;
  _roots: ITask[] = [];
  _rerender?: NodeJS.Immediate;
  _consoleLog = console.log;
  _consoleErr = console.error;
  _consoleWarn = console.warn;
  _consoleInfo = console.info;

  constructor() {
    this._backend = logUpdate.create(process.stdout);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const consoleHandler = (message?: any): void => {
      const current = currentTask.getStore();
      if (current) {
        current.addLog(`${message}`);
      }
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const warningHandler = (message?: any): void => {
      const current = currentTask.getStore();
      if (current) {
        current.addLog(`${message}`);
        current.status = 'warn';
      }
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const errorHandler = (message?: any): void => {
      const current = currentTask.getStore();
      if (current) {
        current.addLog(`${message}`);
        current.status = 'fail';
      }
    };

    console.log = consoleHandler;
    console.warn = warningHandler;
    console.error = errorHandler;
    console.info = consoleHandler;
  }

  _render(): void {
    const lineLen = this._roots.reduce(
      (previous, root) => Math.max(previous, root.lineLength(0)),
      0
    );

    const renders = this._roots.map((r) => r.render(0, lineLen));
    this._backend(renders.join('\n'));
  }

  requestRerender(): void {
    if (!this._rerender) {
      this._rerender = setImmediate(() => {
        this._roots.forEach((r) => r.update());

        this._render();
        this._rerender = undefined;
      });
    }
  }

  rootDone(): void {
    this._terminatedRoots += 1;
    if (this._terminatedRoots === this._roots.length) {
      this.allDone();
    }
  }

  allDone(): void {
    if (this._rerender) clearImmediate(this._rerender);
    this._roots.forEach((r) => r.update());
    this._render();
    this._backend.done();
    console.log = this._consoleLog;
    console.error = this._consoleErr;
    console.warn = this._consoleWarn;
    console.info = this._consoleInfo;

    this._roots.forEach((r) => r.printLogs());
    console.log('\n');
  }
}
