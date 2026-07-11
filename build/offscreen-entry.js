// Entry point for esbuild bundle
// Backends: WebGPU (primary), WebGL (fallback), CPU (last resort)
//
// ВАЖНО: @tensorflow/tfjs-core помечен sideEffects:false — esbuild
// выкидывает side-effect модули при tree-shaking. Chained ops
// (tensor.toFloat, .expandDims и т.д.), которые использует nsfwjs,
// нужно импортировать ЯВНО, иначе classify падает с
// "t.toFloat is not a function" на каждом предсказании.
import '@tensorflow/tfjs-core/dist/public/chained_ops/register_all_chained_ops';
import * as tf from '@tensorflow/tfjs';
import '@tensorflow/tfjs-backend-webgpu';
import '@tensorflow/tfjs-backend-webgl';
import '@tensorflow/tfjs-backend-cpu';
import { load, NSFWJS } from 'nsfwjs/core';

globalThis.tf = tf;
globalThis.nsfwjs = { load, NSFWJS };
