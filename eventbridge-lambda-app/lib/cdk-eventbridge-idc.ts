import * as path from "path";
import * as cdk from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as events_targets from "aws-cdk-lib/aws-events-targets";
import { Construct } from "constructs";
import { Duration } from "aws-cdk-lib";
import { EventBus, Rule } from "aws-cdk-lib/aws-events";
import { Runtime } from "aws-cdk-lib/aws-lambda";
import { ImportedIamIdc, ImportedIamIdcGroup } from "./imported-iam-idc";

export class EventBridgeSSOLambda extends cdk.Stack {
  constructor(scope: Construct, id: string) {
    super(scope, id);

    // Get environment to work with, variables are specified in cdk.json
    const env = process.env.CDK_ENV || "dev";
    const context = this.node.tryGetContext(env);

    // RDS account and region
    const rdsAccountID = context.RDS_ACCOUNT_ID;
    const rdsRegion = context.RDS_REGION;

    // Identity Center region
    const region = cdk.Stack.of(this).region;

    // Specify comma separated list of groups or just a single group
    const groupNames = context.IAM_IDC_GROUP_NAMES.split(",");

    // Get IAM IdC Store ID
    const identityStoreID = new ImportedIamIdc(this, "importedIdc", {
      TargetRegion: region,
    }).idcID;

    // Empty object for group membership data
    let groups: { [groupID: string]: string } = {};
    let groupIDs: string[] = [];

    // Get data for each configured group name
    for (let groupName of groupNames) {
      // Existing Group ID to check against when adding new user to RDS (ex.: DBA group)
      const groupID = new ImportedIamIdcGroup(
        this,
        "iamIdcGroupId" + groupName,
        {
          TargetRegion: region,
          TargetIDC: identityStoreID,
          GroupName: groupName,
        },
      ).groupID;

      // Populate group objects
      groups[groupID] = groupName;
      groupIDs.push(groupID);
    }

    // Existing default EventBridge bus
    const defaultBus = EventBus.fromEventBusName(this, "defaultBus", "default");

    // Custom bus for cross-account event routing
    const ssoBus = new EventBus(this, "ssoBus", {
      eventBusName: "SSO-RDS-Bus",
    });

    // Default bus rule to match new IAM Identity Center users events
    const createSSOUserRule = new Rule(this, "AddUserToGroupRule", {
      description:
        "Add RDS user when an IAM Identity Center user is added to a group",
      eventPattern: {
        source: ["aws.sso-directory"],
        detail: {
          eventSource: ["sso-directory.amazonaws.com"],
          eventName: ["AddMemberToGroup"],
          requestParameters: {
            groupId: groupIDs, // Only matches a specific set of groups
          },
        },
      },
      eventBus: defaultBus,
    });

    // Default bus rule to match delete IAM Identity Center user events
    const deleteSSOUserRule = new Rule(this, "DeleteSSOUserRule", {
      description:
        "Deletes RDS user when user is deleted from IAM Identity Center",
      eventPattern: {
        source: ["aws.sso-directory"],
        detail: {
          eventSource: ["sso-directory.amazonaws.com"],
          eventName: ["DeleteUser"],
        },
      },
      eventBus: defaultBus,
    });

    // Default bus rule to match remove IAM Identity Center user from group events
    const removeSSOUserFromGroupoRule = new Rule(
      this,
      "RemoveUserFromGroupRule",
      {
        description:
          "Deletes RDS user when user is deleted from an IAM Identity Center group",
        eventPattern: {
          source: ["aws.sso-directory"],
          detail: {
            eventSource: ["sso-directory.amazonaws.com"],
            eventName: ["RemoveMemberFromGroup"],
            requestParameters: {
              groupId: groupIDs, // Only matches a specific set of groups
            },
          },
        },
        eventBus: defaultBus,
      },
    );

    /* Lambda function triggered by a IAM IdC user creation
       Creates a new RDS user
       If a new SSO user is in a specific group
       Username in RDS equals to SSO username
    */
    const getUsernameFunction: lambda.Function = new lambda.Function(
      this,
      "getUsernameFromIdc",
      {
        memorySize: 128,
        timeout: Duration.seconds(10),
        runtime: Runtime.PYTHON_3_12,
        handler: "handler.handler",
        code: lambda.Code.fromAsset(
          path.join(__dirname, "../functions/get-username-from-idc"),
        ),
        environment: {
          DEST_BUS_NAME: ssoBus.eventBusName,
        },
      },
    );

    // Add Lambda Function as target to the default bus rules
    const lambdaFuncTarget = new events_targets.LambdaFunction(
      getUsernameFunction,
    );
    createSSOUserRule.addTarget(lambdaFuncTarget);
    deleteSSOUserRule.addTarget(lambdaFuncTarget);
    removeSSOUserFromGroupoRule.addTarget(lambdaFuncTarget);

    // Allow Lambda to put events
    ssoBus.grantPutEventsTo(getUsernameFunction);

    const forwardAllTarget = new events_targets.EventBus(
      EventBus.fromEventBusArn(
        this,
        "rdsAccountCustomBus",
        `arn:aws:events:${rdsRegion}:${rdsAccountID}:event-bus/sso-rds-sync`,
      ),
    );

    new Rule(this, "ForwardAll", {
      description: "Forwards all event to RDS account",
      eventPattern: {
        source: [{ prefix: "" }] as any[],
      },
      eventBus: ssoBus,
      targets: [forwardAllTarget],
    });
  }
}
