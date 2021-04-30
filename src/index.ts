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
import _ from 'lodash';

import { AsyncLocalStorage } from 'async_hooks';

export type Task<T> = () => Promise<T>;

/** */
export type Status = '...' | 'done' | 'skip' | 'warn' | 'fail';

/** */
export interface TaskInfo {
  /** Primary label. */
  label: string;

  /** Current Status. No need to check current status before setting this. */
  status: Status;

  /** Message that appears after the status. */
  message: string;
}

const currentTask = new AsyncLocalStorage<ITaskState>();

let activeRunner: Runner | undefined = undefined;

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

interface ITaskState {
  readonly info: TaskInfo;
  //  owner: Runner;
  subTasks: ITaskState[];

  updateInfo(i: Partial<TaskInfo>): void;

  update(): void;
  wait(): Promise<void>;

  lineLength(depth: number): number;
  rerender(): void;
  render(depth: number, lineLength: number): string;

  addLog(log: string): void;
  printLogs(): void;

  runner: Runner;
}

const performTask = async <T>(task: () => Promise<T>, owner: ITaskState) => {
  try {
    const result = await currentTask.run(owner, task);

    await Promise.all(owner.subTasks.map((t) => t.wait()));

    // In the event the user manually set the state to fail.
    if (owner.info.status === 'fail') {
      throw new Error(owner.info.message);
    }

    owner.updateInfo({ status: 'done' });
    owner.rerender();
    return result;
  } catch (e) {
    owner.updateInfo({ status: 'fail', message: e.message });
    owner.rerender();
    throw e;
  }
};

export class TaskState<T> implements ITaskState {
  runner: Runner;
  info: TaskInfo;
  completion: Promise<T>;

  subTasks: ITaskState[] = [];

  logs: string[] = [];

  constructor(task: () => Promise<T>, runner: Runner, info: Partial<TaskInfo>) {
    this.runner = runner;
    this.info = { status: '...', label: 'Unknown', message: '', ...info };

    this.completion = performTask(task, this);
  }

  updateInfo(info: Partial<TaskInfo>): void {
    if (info.status) {
      this.setStatus(info.status);
    }

    const noStatus = _.omit(info, 'status');
    this.info = { ...this.info, ...noStatus };

    this.rerender();
  }

  setStatus(status: Status): void {
    const currentStr = statusStrength[this.info.status];
    const incomingStr = statusStrength[status];

    if (incomingStr > currentStr) {
      this.info.status = status;
    }
  }

  rerender(): void {
    this.runner.requestRerender();
  }

  addLog(log: string): void {
    this.logs.push(log);
  }

  update(): void {
    if (this.subTasks.length > 0) {
      if (this.subTasks.some((t) => t.info.status === 'fail')) {
        this.updateInfo({ status: 'fail' });
      } else if (this.subTasks.some((t) => t.info.status === 'warn')) {
        this.updateInfo({ status: 'warn' });
      } else if (!this.subTasks.some((t) => t.info.status === '...')) {
        this.updateInfo({ status: 'done' });
      }
    }
  }

  lineLength(depth: number): number {
    return this.subTasks.reduce(
      (previous, task) => Math.max(previous, task.lineLength(depth + 1)),
      stripAnsi(this.info.label).length + 2 * depth
    );
  }

  render(depth: number, lineLength: number): string {
    const pad = ' '.repeat(depth * 2);
    const postPad = '| '.repeat(depth);
    let line =
      `${pad}${this.info.label}`.padEnd(lineLength) +
      `  ${postPad}[${statusText[this.info.status]}]`;

    if (this.info.message.length > 0) {
      line += ` - ${this.info.message}`;
    }

    const available = process.stdout.columns || 80;

    const visualLength = stripAnsi(line).length;
    const ansiCount = line.length - visualLength;

    if (visualLength > available) {
      line = line.slice(0, available + ansiCount - 2) + ' …';
    }

    return [
      line,
      ...this.subTasks.map((t) => t.render(depth + 1, lineLength)),
    ].join('\n');
  }

  printLogs(): void {
    if (this.logs.length > 0) {
      const available = process.stdout.columns || 80;
      const header = `###### ${chalk.cyan(this.info.label)} : ${
        this.logs.length
      } ######`;

      const padding = available - stripAnsi(header).length;
      console.log(`\n${' '.repeat(padding / 2)}${header}`);
      console.log();
      for (const l of this.logs) {
        console.log(l);
      }
    }

    for (const t of this.subTasks) {
      t.printLogs();
    }
  }

  async wait(): Promise<void> {
    // We need to wait on the main task being done first, because it might
    // queue subtasks.
    await this.completion;
    await Promise.all([...this.subTasks.map((t) => t.wait())]);
  }
}

/** Runs a task. If it is called while there is no runner active, it will immediately run the task to completion. */
export const run = async <T>(
  inTask: () => Promise<T>,
  info?: Partial<TaskInfo>
): Promise<T> => {
  const current = currentTask.getStore();
  if (!current) {
    if (!activeRunner) {
      activeRunner = new Runner();
    }

    const taskObj = new TaskState(inTask, activeRunner, info || {});
    activeRunner._roots.push(taskObj);

    try {
      const result = taskObj.completion;
      await result;
      return result;
    } finally {
      activeRunner.rootDone();
    }
  } else {
    const entry = new TaskState(inTask, current.runner, info || {});
    current.subTasks.push(entry);
    current.rerender();

    return entry.completion;
  }
};

/** Runs a task, tolerating errors. If the task fails, it will be marked as "skipped" */
export const tryRun = async <T>(
  inTask: () => Promise<T>,
  info?: Partial<TaskInfo>
): Promise<T | undefined> => {
  return run<T | undefined>(async () => {
    try {
      return await inTask();
    } catch (e) {
      update({ status: 'skip', message: e.message });
    }
  }, info);
};

/** Updates the state of the task currently being run. Does nothing if called out of context. */
export const update = (info: Partial<TaskInfo>): void => {
  const current = currentTask.getStore();
  if (current) {
    current.updateInfo(info);
  }
};

class Runner {
  _terminatedRoots = 0;
  _backend: logUpdate.LogUpdate;
  _roots: ITaskState[] = [];
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
        current.updateInfo({ status: 'warn' });
      }
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const errorHandler = (message?: any): void => {
      const current = currentTask.getStore();
      if (current) {
        current.addLog(`${message}`);
        current.updateInfo({ status: 'fail' });
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
