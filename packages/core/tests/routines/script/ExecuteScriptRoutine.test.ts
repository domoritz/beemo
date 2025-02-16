import Beemo from '../../../src/Beemo';
import ExecuteScriptRoutine from '../../../src/routines/script/ExecuteScriptRoutine';
import {
  mockTool,
  stubScriptContext,
  mockDebugger,
  mockScript,
  TestScript,
} from '../../../src/testUtils';

describe('ExecuteScriptRoutine', () => {
  let routine: ExecuteScriptRoutine;
  let tool: Beemo;

  beforeEach(() => {
    tool = mockTool();

    routine = new ExecuteScriptRoutine('script', 'Run script');
    routine.tool = tool;
    routine.context = stubScriptContext(mockScript('test', tool));
    routine.debug = mockDebugger();
    routine.bootstrap();
  });

  describe('execute()', () => {
    it('calls the script args() and execute()', async () => {
      class BaseTestScript extends TestScript {
        args() {
          return {
            boolean: ['foo'],
            default: {
              foo: false,
            },
          };
        }
      }

      const script = new BaseTestScript();
      script.bootstrap();

      const argsSpy = jest.spyOn(script, 'args');
      const exSpy = jest.spyOn(script, 'execute');

      await routine.execute(routine.context, script);

      expect(argsSpy).toHaveBeenCalled();
      expect(exSpy).toHaveBeenCalledWith(
        routine.context,
        expect.objectContaining({
          _: ['bar', 'baz'],
          a: true,
          foo: true,
        }),
      );
    });

    it('clones the context and sets root to `packageRoot`', async () => {
      routine.options.packageRoot = '/some/path';

      const script = mockScript('test');
      const exSpy = jest.spyOn(script, 'execute');

      await routine.execute(routine.context, script);

      expect(exSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          cwd: '/some/path',
        }),
        expect.anything(),
      );
    });

    it('add tasks to parent routine', async () => {
      class TasksScript extends TestScript {
        bootstrap() {
          this.task('Task', () => 123);
          this.task('Task', () => 456);
          this.task('Task', () => 789);
        }
      }

      const script = new TasksScript();
      script.bootstrap();

      // Not bootstrapped for this test so its 0 instead of 2
      expect(routine.tasks).toHaveLength(0);

      await routine.execute(routine.context, script);

      expect(routine.tasks).toHaveLength(3);
    });

    it('parallelizes tasks', async () => {
      class ParallelTasksScript extends TestScript {
        bootstrap() {
          this.task('Task', () => 123);
          this.task('Task', () => 456);
          this.task('Task', () => 789);
        }

        execute() {
          return this.executeTasks('parallel');
        }
      }

      const script = new ParallelTasksScript();
      script.bootstrap();

      const spy = jest.spyOn(routine, 'parallelizeTasks');

      await routine.execute(routine.context, script);

      expect(spy).toHaveBeenCalledWith(expect.anything());
    });

    it('pools tasks', async () => {
      class PoolTasksScript extends TestScript {
        bootstrap() {
          this.task('Task', () => 123);
          this.task('Task', () => 456);
          this.task('Task', () => 789);
        }

        execute() {
          return this.executeTasks('pool');
        }
      }

      const script = new PoolTasksScript();
      script.bootstrap();

      const spy = jest.spyOn(routine, 'poolTasks');

      await routine.execute(routine.context, script);

      expect(spy).toHaveBeenCalledWith(expect.anything());
    });

    it('serializes tasks', async () => {
      class SerialTasksScript extends TestScript {
        bootstrap() {
          this.task('Task', () => 123);
          this.task('Task', () => 456);
          this.task('Task', () => 789);
        }

        execute() {
          return this.executeTasks('serial');
        }
      }

      const script = new SerialTasksScript();
      script.bootstrap();

      const spy = jest.spyOn(routine, 'serializeTasks');

      await routine.execute(routine.context, script);

      expect(spy).toHaveBeenCalledWith(expect.anything());
    });

    it('synchronizes tasks', async () => {
      class SyncTasksScript extends TestScript {
        bootstrap() {
          this.task('Task', () => 123);
          this.task('Task', () => 456);
          this.task('Task', () => 789);
        }

        execute() {
          return this.executeTasks('sync');
        }
      }

      const script = new SyncTasksScript();
      script.bootstrap();

      const spy = jest.spyOn(routine, 'synchronizeTasks');

      await routine.execute(routine.context, script);

      expect(spy).toHaveBeenCalledWith(expect.anything());
    });

    it('doesnt run script tasks if `executeTasks` is not called', async () => {
      class NoTasksScript extends TestScript {
        bootstrap() {
          this.task('Task', () => 123);
        }

        execute() {
          return Promise.resolve();
        }
      }

      const script = new NoTasksScript();
      script.bootstrap();

      const exSpy = jest.spyOn(script, 'executeTasks');

      await routine.execute(routine.context, script);

      expect(exSpy).not.toHaveBeenCalled();
    });

    it('emits `onBeforeExecute` event', async () => {
      class MockScript extends TestScript {
        execute() {
          return Promise.resolve();
        }
      }

      const spy = jest.fn();
      const script = new MockScript();

      script.onBeforeExecute.listen(spy);
      script.bootstrap();

      await routine.execute(routine.context, script);

      expect(spy).toHaveBeenCalledWith(routine.context, routine.context.argv);
    });

    it('emits `onAfterExecute` event on success', async () => {
      class SuccessScript extends TestScript {
        execute() {
          return Promise.resolve(123);
        }
      }

      const spy = jest.fn();
      const script = new SuccessScript();

      script.onAfterExecute.listen(spy);
      script.bootstrap();

      await routine.execute(routine.context, script);

      expect(spy).toHaveBeenCalledWith(routine.context, 123);
    });

    it('emits `onFailedExecute` event on failure', async () => {
      class FailureScript extends TestScript {
        execute() {
          return Promise.reject(new Error('Oops'));
        }
      }

      const spy = jest.fn();
      const script = new FailureScript();

      script.onFailedExecute.listen(spy);
      script.bootstrap();

      try {
        await routine.execute(routine.context, script);
      } catch (error) {
        expect(spy).toHaveBeenCalledWith(routine.context, error);
      }
    });
  });

  describe('runScriptTasks()', () => {
    it('rebinds the task to the script', () => {
      class TaskScript extends TestScript {
        bootstrap() {
          this.task('Test', this.boundTask);
        }

        boundTask() {
          // eslint-disable-next-line
          expect(this).toBe(script);

          return this.otherMethod();
        }

        otherMethod() {
          // eslint-disable-next-line
          expect(this).toBe(script);

          return true;
        }
      }

      const script = new TaskScript();
      script.bootstrap();

      routine.context.script = script;

      routine.runScriptTasks({} as $FixMe, 'pool', script.tasks);
    });
  });
});
