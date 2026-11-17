import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { NotesApiStack } from '../lib/notes-api-stack';

function synth(stage: 'dev' | 'prod') {
  const app = new cdk.App();
  return Template.fromStack(new NotesApiStack(app, `ServerlessNotes-${stage}`, { stage }));
}

describe('serverless foundation', () => {
  it('synthesizes a secured dev API with least-privilege data access and protection', () => {
    const template = synth('dev');
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      BillingMode: 'PAY_PER_REQUEST',
      PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
      KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }, { AttributeName: 'sk', KeyType: 'RANGE' }],
    });
    template.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      GenerateSecret: false,
      AllowedOAuthFlowsUserPoolClient: false,
      ExplicitAuthFlows: Match.arrayWith(['ALLOW_USER_PASSWORD_AUTH']),
    });
    template.resourceCountIs('AWS::ApiGateway::Method', 5);
    const methods = Object.values(template.findResources('AWS::ApiGateway::Method'));
    expect(methods.every(method => method.Properties.AuthorizationType === 'COGNITO_USER_POOLS' && method.Properties.AuthorizerId)).toBe(true);
    template.hasResourceProperties('AWS::ApiGateway::Method', {
      AuthorizationType: 'COGNITO_USER_POOLS',
      AuthorizerId: Match.anyValue(),
    });
    template.hasResourceProperties('AWS::ApiGateway::Stage', {
      TracingEnabled: true,
      MethodSettings: Match.arrayWith([Match.objectLike({ ThrottlingRateLimit: 5, ThrottlingBurstLimit: 10 })]),
    });
    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs20.x', TracingConfig: { Mode: 'Active' }, Timeout: 10,
    });
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: { Statement: Match.arrayWith([Match.objectLike({
        Action: ['dynamodb:GetItem', 'dynamodb:Query', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem'],
        Resource: { 'Fn::GetAtt': [Match.stringLikeRegexp('NotesTable'), 'Arn'] },
      })]) },
    });
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: { Statement: Match.arrayWith([Match.objectLike({
        Action: ['logs:CreateLogStream', 'logs:PutLogEvents'],
      })]) },
    });
    template.resourceCountIs('AWS::CloudWatch::Alarm', 2);
    template.resourceCountIs('AWS::WAFv2::WebACL', 0);
  });

  it('protects production state and uses stricter prod settings', () => {
    const template = synth('prod');
    template.hasResourceProperties('AWS::DynamoDB::Table', { DeletionProtectionEnabled: true });
    template.hasResource('AWS::DynamoDB::Table', { DeletionPolicy: 'Retain' });
    template.hasResourceProperties('AWS::ApiGateway::Stage', {
      StageName: 'prod', MethodSettings: Match.arrayWith([Match.objectLike({ ThrottlingRateLimit: 50, ThrottlingBurstLimit: 100 })]),
    });
    template.hasResourceProperties('AWS::Logs::LogGroup', { RetentionInDays: 30 });
  });
});
