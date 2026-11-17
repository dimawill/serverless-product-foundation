import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

export type Stage = 'dev' | 'prod';
export interface NotesApiStackProps extends cdk.StackProps {
  stage: Stage;
}

export class NotesApiStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: NotesApiStackProps) {
    super(scope, id, props);
    const prod = props.stage === 'prod';
    const retention = prod ? logs.RetentionDays.ONE_MONTH : logs.RetentionDays.ONE_WEEK;

    const table = new dynamodb.Table(this, 'NotesTable', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      deletionProtection: prod,
      removalPolicy: prod ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    const pool = new cognito.UserPool(this, 'UserPool', {
      selfSignUpEnabled: true,
      signInAliases: { email: true },
      autoVerify: { email: true },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      passwordPolicy: {
        minLength: 12,
        requireDigits: true,
        requireLowercase: true,
        requireUppercase: true,
        requireSymbols: true,
      },
      removalPolicy: prod ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });
    const client = pool.addClient('CliClient', {
      generateSecret: false,
      disableOAuth: true,
      authFlows: { userPassword: true },
      preventUserExistenceErrors: true,
    });

    const functionLogs = new logs.LogGroup(this, 'FunctionLogs', {
      retention,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const executionRole = new iam.Role(this, 'NotesExecutionRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    });
    executionRole.addToPolicy(new iam.PolicyStatement({
      actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
      resources: [`${functionLogs.logGroupArn}:*`],
    }));
    const fn = new nodejs.NodejsFunction(this, 'NotesHandler', {
      entry: path.join(__dirname, '../lambda/notes.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      logGroup: functionLogs,
      role: executionRole,
      tracing: lambda.Tracing.ACTIVE,
      timeout: cdk.Duration.seconds(10),
      memorySize: 256,
      environment: { TABLE_NAME: table.tableName },
      bundling: { minify: true, sourceMap: true },
    });
    fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['dynamodb:GetItem', 'dynamodb:Query', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem'],
      resources: [table.tableArn],
    }));

    const accessLogs = new logs.LogGroup(this, 'ApiAccessLogs', {
      retention,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const api = new apigateway.RestApi(this, 'NotesApi', {
      restApiName: `NotesApi-${props.stage}`,
      deployOptions: {
        stageName: props.stage,
        tracingEnabled: true,
        throttlingRateLimit: prod ? 50 : 5,
        throttlingBurstLimit: prod ? 100 : 10,
        metricsEnabled: true,
        loggingLevel: apigateway.MethodLoggingLevel.ERROR,
        dataTraceEnabled: false,
        accessLogDestination: new apigateway.LogGroupLogDestination(accessLogs),
        accessLogFormat: apigateway.AccessLogFormat.jsonWithStandardFields(),
      },
      cloudWatchRole: true,
    });
    const authorizer = new apigateway.CognitoUserPoolsAuthorizer(this, 'UserPoolAuthorizer', {
      cognitoUserPools: [pool],
    });
    const integration = new apigateway.LambdaIntegration(fn);
    const notes = api.root.addResource('notes');
    const item = notes.addResource('{id}');
    for (const method of ['GET', 'POST']) {
      notes.addMethod(method, integration, { authorizer, authorizationType: apigateway.AuthorizationType.COGNITO });
    }
    for (const method of ['GET', 'PUT', 'DELETE']) {
      item.addMethod(method, integration, { authorizer, authorizationType: apigateway.AuthorizationType.COGNITO });
    }

    new cloudwatch.Alarm(this, 'Api5xxAlarm', {
      metric: api.metricServerError({ period: cdk.Duration.minutes(5), statistic: 'Sum' }),
      threshold: 5,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    new cloudwatch.Alarm(this, 'LambdaErrorAlarm', {
      metric: fn.metricErrors({ period: cdk.Duration.minutes(5), statistic: 'Sum' }),
      threshold: 1,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // Optional paid protection: attach a regional WAFv2 WebACL to api.deploymentStage.stageArn.
    // Not enabled by default because WAF has fixed monthly and request charges.

    new cdk.CfnOutput(this, 'ApiUrl', { value: api.url });
    new cdk.CfnOutput(this, 'UserPoolId', { value: pool.userPoolId });
    new cdk.CfnOutput(this, 'AppClientId', { value: client.userPoolClientId });
    new cdk.CfnOutput(this, 'AwsRegion', { value: this.region });
  }
}
