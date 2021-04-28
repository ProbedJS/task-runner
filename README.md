#  Task Runner:

A straightforward batch task runner with good looking logs.

N.B. This library does not use (liberator)[http://example.com], because it is a dependency of it.


## Usage:

### Creating and running a task:
```
import { run } from '@probedjs/task-runner';

const result = run("My Build", async () => {
    // Do the build here.

    return "all done!";
})

console.log(await result); // Will print "all done!"
```

### Running Subtasks:

When `run()` is called from within a task, that creates a subtask.

```
import {run} from '@probedjs/task-runner';

await run("My Build", async () => {
    run("step 1", async ()=>{
        //...
    })

    run("step 2", async ()=>{
        //...
    })

    // No need to explicitely await the subtasks
})
```

### Dependencies:

If a task depends on the results of another, simply await the results 

```
import {run} from '@probedjs/task-runner';

await run("My Build", async () => {
    const dataProm = run("step 1", async ()=>{
        return { filename: "path/to/file" };
    })

    run("step 2", async () => {
        const data = await dataProm;

        // use data.
    })
})
```

### Dynamic tasks:

Task lists do not have to be fixed. They can even depend on the result of some other task:

```
import {run} from '@probedjs/task-runner';

await run("My Build", async () => {
    const cacheProm = run("Load Cache", async ()=>{
        // return either a cache or undefined.
    })


    if(await cacheProm === undefined) {
        run("full build", async()=>{
            //...
        });
    }
})
```

### Optional tasks:

Optional tasks do not fail their parent if they fail themselves:

```
import {run, runOptional} from '@probedjs/task-runner';
import { default as fs } from 'fs-extra';

await run("My Build", async () => {
    const cleanupDone = runOptional("Remove old build", ()=>fs.rm("path/to/dist"));

    run("Build", async () => {
        await cleanupDone;

        // Do the build
    });
})
```

### Messages and status:

For the most part, status is handled automatically. However, you still can set the status of a
task manually.

```
import { run, setMessage, setStatus } from '@probedjs/task-runner';

await run("My Build", async () => {
    setMessage("Hi There");
    setStatus('warn');
})
```