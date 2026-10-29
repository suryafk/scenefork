// The demo's flows end to end (eng review D10): golden fork, live fork, presets, codegen and
// the demo key. Fake models only. Checks go through the dev trace (window.__sfTrace).
import { expect, test, type Page } from '@playwright/test';
import { E2E_KEY } from '../playwright.config';

const FRAME_W = 1280;

async function open(page: Page, key = E2E_KEY) {
  await page.goto(`/#k=${key}`);
  await page.waitForFunction(() => (window as unknown as { __sfDebug?: unknown }).__sfDebug !== undefined);
  await traced(page, /\[physics\] ready/);
}

/** Wait until some trace line matches. */
async function traced(page: Page, pattern: RegExp, timeout = 10_000) {
  await page.waitForFunction(
    (src) => ((window as unknown as { __sfTrace?: string[] }).__sfTrace ?? []).some((l) => new RegExp(src).test(l)),
    pattern.source,
    { timeout },
  );
}

/** A real mouse click at frame pixel coordinates on the canvas. */
async function clickFrame(page: Page, x: number, y: number) {
  const box = (await page.locator('.canvas-host canvas').boundingBox())!;
  const s = box.width / FRAME_W;
  await page.mouse.click(box.x + x * s, box.y + y * s);
}

async function dragFrame(page: Page, from: [number, number], to: [number, number]) {
  const box = (await page.locator('.canvas-host canvas').boundingBox())!;
  const s = box.width / FRAME_W;
  await page.mouse.move(box.x + from[0] * s, box.y + from[1] * s);
  await page.mouse.down();
  await page.mouse.move(box.x + to[0] * s, box.y + to[1] * s, { steps: 20 });
  await page.waitForTimeout(400);
  await page.mouse.up();
}

test('golden clip: frees an object from static files', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: /Test street/ }).click();
  await traced(page, /\[golden\] start test_street 0/);
  await clickFrame(page, 920, 530);
  await traced(page, /\[golden\] free obj_3/);
  await traced(page, /\[physics\] added obj_3/);
  // Throwing it moves the body (frame pixels, from the physics snapshot).
  await dragFrame(page, [920, 535], [700, 380]);
  await page.waitForTimeout(600);
  const x = await page.evaluate(() => {
    const p = (window as unknown as { __sfDebug: { physics: { latestSnapshot: { bodies: { id: string; x: number }[] } } } }).__sfDebug.physics;
    return p.latestSnapshot.bodies.find((b) => b.id === 'obj_3')!.x * 100;
  });
  expect(x).toBeLessThan(880);
});

test('live fork: click-to-free through the fake backend', async ({ page }) => {
  await open(page);
  await expect(page.getByText('backend: open')).toBeVisible();
  await page.getByRole('button', { name: 'Fork the demo street' }).click();
  await clickFrame(page, 1215, 470); // the trash bin
  await traced(page, /\[fork\] freed/);
  await traced(page, /\[physics\] added obj_/);
  await traced(page, /\[fork\] plate/);
});

test('preset by typed command applies with no model call', async ({ page }) => {
  await open(page);
  await page.getByLabel('Type a physics rule').fill('moon gravity');
  await page.getByRole('button', { name: 'Apply' }).click();
  await expect(page.locator('.rules')).toContainText('Moon gravity');
  await page.getByRole('button', { name: 'reset all' }).click();
  await expect(page.locator('.rules')).toHaveCount(0);
});

test('codegen: the fake mutator writes a plugin that passes the verifier and installs', async ({ page }) => {
  await open(page);
  await expect(page.getByText('backend: open')).toBeVisible();
  await page.getByLabel('Type a physics rule').fill('slingshot the truck');
  await page.getByRole('button', { name: 'Apply' }).click();
  await expect(page.locator('.mutator-log')).toContainText('installed', { timeout: 15_000 });
  await expect(page.locator('.rules')).toContainText('slingshot_red_delivery_truck');
});

test('codegen: an unknown command fails gracefully', async ({ page }) => {
  await open(page);
  await expect(page.getByText('backend: open')).toBeVisible();
  await page.getByLabel('Type a physics rule').fill('paint the sky purple');
  await page.getByRole('button', { name: 'Apply' }).click();
  await expect(page.locator('.mutator-log')).toContainText('failed', { timeout: 15_000 });
  await expect(page.locator('.toast')).toContainText("Couldn't build that rule");
});

test('a wrong demo key is refused', async ({ page }) => {
  await open(page, 'wrong');
  await expect(page.getByText('backend: unauthorized')).toBeVisible();
});

test('suggested rules appear for the scene, and a chip builds its rule', async ({ page }) => {
  await open(page);
  await expect(page.getByText('backend: open')).toBeVisible();
  const chips = page.getByRole('group', { name: 'Suggested rules' });
  await expect(chips.getByRole('button')).toHaveCount(4, { timeout: 10_000 });
  await chips.getByRole('button', { name: /slingshot the truck/ }).click();
  await expect(page.locator('.mutator-log')).toContainText('installed', { timeout: 15_000 });
  await expect(page.locator('.rules')).toContainText('slingshot_red_delivery_truck');
});
