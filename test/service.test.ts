import { expect, test } from 'bun:test';
import { newerVersion, serviceSupported, taskXml } from '../src/service';

test('versions compare numerically', () => {
  expect(newerVersion('0.26.10', '0.26.9')).toBe(true);
  expect(newerVersion('0.27.0', '0.26.9')).toBe(true);
  expect(newerVersion('0.26.2', '0.26.2')).toBe(false);
  expect(newerVersion('0.26.1', '0.26.2')).toBe(false);
});

test('task: starts at boot as the user, never times out, restarts on failure, runs "service"', () => {
  const x = taskXml('CONTOSO\\jane', 'C:\\Users\\A&B\\AppData\\Local\\soccer-edge\\bin\\soccer-edge.exe');
  expect(x).toContain('<BootTrigger>');
  expect(x).toContain('<UserId>CONTOSO\\jane</UserId>');
  expect(x).toContain('<LogonType>Password</LogonType>');
  expect(x).toContain('<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>');
  expect(x).toContain('<RestartOnFailure>');
  expect(x).toContain('<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>');
  expect(x).toContain('<Arguments>service</Arguments>');
  expect(x).toContain('A&amp;B'); // escaped
  expect(x).not.toMatch(/&(?!amp;|lt;|gt;|quot;)/);
});

test('not offered outside the Windows exe', () => {
  expect(serviceSupported()).toBe(false);
});
