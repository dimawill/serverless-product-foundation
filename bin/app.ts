#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { NotesApiStack, type Stage } from '../lib/notes-api-stack';

const app = new cdk.App();
const stage = app.node.tryGetContext('stage') as string;
if (stage !== 'dev' && stage !== 'prod') {
  throw new Error('Set -c stage=dev or -c stage=prod');
}
new NotesApiStack(app, `ServerlessNotes-${stage}`, {
  stage: stage as Stage,
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
