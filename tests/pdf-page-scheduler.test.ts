import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runOrderedPool } from '../lib/pdf-page-scheduler';

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('ordered parallel page pool', () => {
  it('emits results in page order even when workers finish out of order', async () => {
    const received: Array<[number, number]> = [];
    await runOrderedPool({
      total: 6,
      concurrency: 3,
      worker: async (index) => {
        // Later pages finish first.
        await delay((7 - index) * 3);
        return index * 10;
      },
      onResult: (index, value) => received.push([index, value]),
    });

    assert.deepEqual(
      received.map(([index]) => index),
      [1, 2, 3, 4, 5, 6]
    );
    assert.deepEqual(
      received.map(([, value]) => value),
      [10, 20, 30, 40, 50, 60]
    );
  });

  it('never exceeds the configured concurrency', async () => {
    let active = 0;
    let peak = 0;
    await runOrderedPool({
      total: 20,
      concurrency: 3,
      worker: async () => {
        active++;
        peak = Math.max(peak, active);
        await delay(2);
        active--;
      },
      onResult: () => {},
    });
    assert.equal(peak, 3);
  });

  it('stops scheduling new work after abort', async () => {
    const controller = new AbortController();
    const started: number[] = [];
    await runOrderedPool({
      total: 50,
      concurrency: 2,
      signal: controller.signal,
      worker: async (index) => {
        started.push(index);
        if (index === 3) controller.abort();
        await delay(1);
      },
      onResult: () => {},
    });
    assert.ok(started.length < 50);
  });

  it('propagates the first worker error', async () => {
    await assert.rejects(
      runOrderedPool({
        total: 5,
        concurrency: 2,
        worker: async (index) => {
          if (index === 2) throw new Error('page 2 exploded');
          return index;
        },
        onResult: () => {},
      }),
      /page 2 exploded/
    );
  });
});
