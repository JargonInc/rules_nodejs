/**
 * @fileoverview Runner is the entry point of running Tsetse checks in compiler.
 */
import * as pluginApi from '../tsc_wrapped/plugin_api';
import { Checker } from './checker';
/**
 * The Tsetse check plugin performs compile-time static analysis for TypeScript
 * code.
 */
export declare const PLUGIN: pluginApi.Plugin;
export declare function registerRules(checker: Checker, disabledTsetseRules: string[]): void;
