import * as path from 'path';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import { EmailSubscription } from 'aws-cdk-lib/aws-sns-subscriptions';
import { Construct } from 'constructs';
import { Duration } from 'aws-cdk-lib';
import { Runtime } from 'aws-cdk-lib/aws-lambda';
import { LambdaDestination } from 'aws-cdk-lib/aws-lambda-destinations';

interface FailureNotificationProps extends cdk.StackProps {
    email: string;
  }

export class LambdaSNSFailureNotification extends cdk.Stack {
    public readonly notifyFailureDest: LambdaDestination;

    constructor(scope: Construct, id: string, props: FailureNotificationProps) {
      super(scope, id, props);

      // Create new SNS topic with e-mail subscription (requires confirmation via e-mail)
      const topic = new sns.Topic(this, "notifySSOToRDSFailure");
      topic.addSubscription(
        new EmailSubscription(props.email)
      );

      // Lambda function formats message to be human-readable and sends it to a SNS topic
      const notifyFailure: lambda.Function = new lambda.Function(this, 'notifyFailureFunction', {
        memorySize: 128,
        timeout: Duration.seconds(10),
        runtime: Runtime.PYTHON_3_10,
        handler: 'handler.handler',
        environment: {
          SNS_ARN: topic.topicArn,
        },
        code: lambda.Code.fromAsset(path.join(__dirname, '../src/sns-notify-function'))
      });

      //IAM Policy for Lambda function to SNS
      const lambdaToSNSPolicy = new iam.PolicyStatement({
        actions: [
          'sns:Publish'
        ],
        resources: [
          topic.topicArn,
        ]
      });

      // Attach Policy to Lambda
      notifyFailure.role?.attachInlinePolicy(
        new iam.Policy(this, 'lambda-to-sns-publish-policy', {
            statements: [lambdaToSNSPolicy]
        })
      );

      this.notifyFailureDest = new LambdaDestination(notifyFailure);

    }
}