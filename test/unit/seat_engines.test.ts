import { describe, expect, it, vi } from 'vitest';
import type { Engine } from 'fascicle';
import { create_seat_engines, dispose_seat_engines } from '../../src/engine.js';
import type { EngineOptions, SeatEngines } from '../../src/engine.js';

/** Real engines with an empty environment. Building one spawns nothing and
 * makes no request, so these only ask which engine each seat gets. */
async function seats(options: Omit<EngineOptions, 'workspace'>): Promise<SeatEngines> {
  return create_seat_engines({ workspace: '.', env: {}, ...options });
}

describe('create_seat_engines', () => {
  it('shares one engine when neither seat names a URL', async () => {
    const engines = await seats({ builder_provider: 'ollama', critic_provider: 'ollama' });
    try {
      expect(engines.critic).toBe(engines.builder);
    } finally {
      await dispose_seat_engines(engines);
    }
  });

  it('shares one engine when a seat is claude_cli', async () => {
    const engines = await seats({
      builder_provider: 'claude_cli',
      critic_provider: 'ollama',
      critic_url: 'http://critic-box:11434',
    });
    try {
      expect(engines.critic).toBe(engines.builder);
    } finally {
      await dispose_seat_engines(engines);
    }
  });

  it('shares one engine across two different providers, each at its own URL', async () => {
    const engines = await seats({
      builder_provider: 'ollama',
      builder_url: 'http://builder-box:11434',
      critic_provider: 'lmstudio',
      critic_url: 'http://critic-box:1234/v1',
    });
    try {
      expect(engines.critic).toBe(engines.builder);
    } finally {
      await dispose_seat_engines(engines);
    }
  });

  it('shares one engine when both seats name one server, however it is spelled', async () => {
    const engines = await seats({
      builder_provider: 'ollama',
      builder_url: 'http://box:11434/api',
      critic_provider: 'ollama',
      critic_url: 'http://box:11434/',
    });
    try {
      expect(engines.critic).toBe(engines.builder);
    } finally {
      await dispose_seat_engines(engines);
    }
  });

  it('gives the critic its own engine when the seats share a provider at different URLs', async () => {
    const engines = await seats({
      builder_provider: 'ollama',
      builder_url: 'http://localhost:11522',
      critic_provider: 'ollama',
      critic_url: 'http://localhost:11523',
    });
    try {
      expect(engines.critic).not.toBe(engines.builder);
    } finally {
      await dispose_seat_engines(engines);
    }
  });

  it("splits when only the critic names a URL, apart from the env var's", async () => {
    const engines = await create_seat_engines({
      workspace: '.',
      env: { VOLLEY_LMSTUDIO_URL: 'http://localhost:1234/v1' },
      builder_provider: 'lmstudio',
      critic_provider: 'lmstudio',
      critic_url: 'http://critic-box:1234/v1',
    });
    try {
      expect(engines.critic).not.toBe(engines.builder);
    } finally {
      await dispose_seat_engines(engines);
    }
  });
});

type FakeEngine = Engine & { dispose: ReturnType<typeof vi.fn> };

/** An engine that only knows how to be disposed, and counts it. */
function fake_engine(): FakeEngine {
  return { dispose: vi.fn(async () => {}) } as unknown as FakeEngine;
}

describe('dispose_seat_engines', () => {
  it('disposes a shared engine once', async () => {
    const engine = fake_engine();
    await dispose_seat_engines({ builder: engine, critic: engine });
    expect(engine.dispose).toHaveBeenCalledTimes(1);
  });

  it('disposes both engines of a split pair', async () => {
    const builder = fake_engine();
    const critic = fake_engine();
    await dispose_seat_engines({ builder, critic });
    expect(builder.dispose).toHaveBeenCalledTimes(1);
    expect(critic.dispose).toHaveBeenCalledTimes(1);
  });
});
