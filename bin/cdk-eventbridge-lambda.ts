#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { NewSSOUserToRDS } from '../lib/cdk-eventbridge-lambda-stack';

const app = new cdk.App();
const envDefault = { region: process.env.CDK_DEFAULT_REGION, account: process.env.CDK_DEFAULT_ACCOUNT };
new NewSSOUserToRDS(app, 'NewSsoUserToRdsStack', { env: envDefault });
