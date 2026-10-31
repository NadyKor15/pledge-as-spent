import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { awsCredentialsProvider } from "@vercel/oidc-aws-credentials-provider";
import { BEDROCK_REGION, createBedrockClient, type ConverseClient } from "../receipts/bedrock";

/** On Vercel: short-lived credentials of the Nova-only role, no stored key. Elsewhere: the usual AWS chain. */
export function bedrockClient(roleArn = process.env.AWS_ROLE_ARN): ConverseClient {
  if (!roleArn) return createBedrockClient();
  return new BedrockRuntimeClient({ region: BEDROCK_REGION, credentials: awsCredentialsProvider({ roleArn }) });
}
