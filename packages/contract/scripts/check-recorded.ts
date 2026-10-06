// The contract's one check: every recorded real response (recorded/*.json,
// written by record.mjs) decodes against its schema, with unknown fields
// refused, so a field the Worker sends and the contract lacks fails here too.
// Run: npm run check -w @pando/contract
import { readdirSync, readFileSync } from "node:fs";

import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { flow } from "effect/Function";
import * as Result from "effect/Result";

import {
  ActivityFrame,
  AgentLiveFrame,
  AgentModels,
  AgentSession,
  AgentSessionList,
  AgentTranscript,
  Branch,
  BranchCommits,
  BranchDiff,
  BranchDiffLine,
  BranchList,
  Checks,
  CiBuildList,
  decodeStrict,
  ErrorBody,
  EventsPage,
  MachineList,
  Me,
  MemberList,
  CiBuildDetail,
  HeadList,
  HistoryPage,
  LastCommits,
  MergeResult,
  MetaFileHeaders,
  MetaHistory,
  MetaTree,
  MonorepoEntry,
  MonorepoFeedFrame,
  MonorepoList,
  MonorepoSummaryList,
  NeedsPage,
  Repo,
  RepoList,
  Restored,
  ReviewList,
  SignedOut,
  TreePage,
  WorktreeList,
  CiAnnotationList,
  CiArtifactList,
  CiBuildAnswer,
  CiConnected,
  GithubRepos,
  Mirror,
  MirrorQueued,
  MirrorSaved,
  CiJobAnswer,
  CiJobLog,
  CiOverview,
  CiPipelinePage,
  CredentialList,
  InviteList,
  InviteResult,
  MonorepoRenamed,
  Hook,
  MonorepoEventFrame,
  Issue,
  IssueComment,
  IssueList,
  Label,
  LabelList,
  ReactionsAnswer,
  Timeline,
  Session,
  SessionAny,
  BranchSessions,
  PersonSessions,
  SessionFiles,
  SessionMarks,
  SessionsDeleted,
  SessionEntries,
  SessionExclusions,
  SessionList,
  SessionMachines,
  MonorepoCreated,
  Org,
  OrgInviteResult,
  OrgList,
  OrgMember,
  OrgMemberList,
  Owner,
  Profile,
  Contributions,
  ContributionPeriod,
} from "../src/index.ts";

const Recording = Schema.Struct({
  schema: Schema.String,
  route: Schema.String,
  status: Schema.Int,
  body: Schema.Unknown,
});

/** A decoder that answers the failure, if any, so every entry has one type. */
const refuses = <A, I>(schema: Schema.Codec<A, I>) => flow(decodeStrict(schema), Result.getFailure);

const decoders = {
  Me: refuses(Me),
  "AgentLiveFrame[]": refuses(Schema.Array(AgentLiveFrame)),
  AgentModels: refuses(AgentModels),
  AgentSession: refuses(AgentSession),
  AgentSessionList: refuses(AgentSessionList),
  AgentTranscript: refuses(AgentTranscript),
  ErrorBody: refuses(ErrorBody),
  MonorepoList: refuses(MonorepoList),
  MonorepoSummaryList: refuses(MonorepoSummaryList),
  EventsPage: refuses(EventsPage),
  NeedsPage: refuses(NeedsPage),
  "ActivityFrame[]": refuses(Schema.Array(ActivityFrame)),
  "MonorepoFeedFrame[]": refuses(Schema.Array(MonorepoFeedFrame)),
  "MonorepoEventFrame[]": refuses(Schema.Array(MonorepoEventFrame)),
  MetaTree: refuses(MetaTree),
  MetaHistory: refuses(MetaHistory),
  MetaFileHeaders: refuses(MetaFileHeaders),
  MonorepoEntry: refuses(MonorepoEntry),
  RepoList: refuses(RepoList),
  HeadList: refuses(HeadList),
  TreePage: refuses(TreePage),
  LastCommits: refuses(LastCommits),
  HistoryPage: refuses(HistoryPage),
  WorktreeList: refuses(WorktreeList),
  CiBuildDetail: refuses(CiBuildDetail),
  CiOverview: refuses(CiOverview),
  CiPipelinePage: refuses(CiPipelinePage),
  CiJobLog: refuses(CiJobLog),
  CiAnnotationList: refuses(CiAnnotationList),
  CiArtifactList: refuses(CiArtifactList),
  CiBuildAnswer: refuses(CiBuildAnswer),
  CiJobAnswer: refuses(CiJobAnswer),
  CiConnected: refuses(CiConnected),
  GithubRepos: refuses(GithubRepos),
  Mirror: refuses(Mirror),
  MirrorQueued: refuses(MirrorQueued),
  MirrorSaved: refuses(MirrorSaved),
  CredentialList: refuses(CredentialList),
  InviteList: refuses(InviteList),
  InviteResult: refuses(InviteResult),
  MonorepoRenamed: refuses(MonorepoRenamed),
  MonorepoCreated: refuses(MonorepoCreated),
  Owner: refuses(Owner),
  Profile: refuses(Profile),
  Contributions: refuses(Contributions),
  ContributionPeriod: refuses(ContributionPeriod),
  Org: refuses(Org),
  OrgList: refuses(OrgList),
  OrgMember: refuses(OrgMember),
  OrgMemberList: refuses(OrgMemberList),
  OrgInviteResult: refuses(OrgInviteResult),
  Hook: refuses(Hook),
  /** A 204: no body. */
  NoContent: refuses(Schema.Null),
  Repo: refuses(Repo),
  MemberList: refuses(MemberList),
  MachineList: refuses(MachineList),
  BranchList: refuses(BranchList),
  Branch: refuses(Branch),
  BranchCommits: refuses(BranchCommits),
  BranchDiff: refuses(BranchDiff),
  BranchDiffLine: refuses(BranchDiffLine),
  ReviewList: refuses(ReviewList),
  Checks: refuses(Checks),
  CiBuildList: refuses(CiBuildList),
  MergeResult: refuses(MergeResult),
  Restored: refuses(Restored),
  SignedOut: refuses(SignedOut),
  Issue: refuses(Issue),
  IssueComment: refuses(IssueComment),
  IssueList: refuses(IssueList),
  Label: refuses(Label),
  LabelList: refuses(LabelList),
  ReactionsAnswer: refuses(ReactionsAnswer),
  Timeline: refuses(Timeline),
  Session: refuses(Session),
  SessionAny: refuses(SessionAny),
  BranchSessions: refuses(BranchSessions),
  PersonSessions: refuses(PersonSessions),
  SessionFiles: refuses(SessionFiles),
  SessionMarks: refuses(SessionMarks),
  SessionsDeleted: refuses(SessionsDeleted),
  SessionEntries: refuses(SessionEntries),
  SessionList: refuses(SessionList),
  SessionExclusions: refuses(SessionExclusions),
  SessionMachines: refuses(SessionMachines),
};

const isDecoderName = (name: string): name is keyof typeof decoders => Object.hasOwn(decoders, name);

const folder = new URL("../recorded/", import.meta.url);

const files = readdirSync(folder).filter((file) => file.endsWith(".json")).sort();

let failures = 0;

for (const file of files) {
  const recording = Schema.decodeUnknownSync(Recording)(JSON.parse(readFileSync(new URL(file, folder), "utf8")));

  if (!isDecoderName(recording.schema)) {
    failures++;
    console.log(`FAIL  ${file}: no schema named ${recording.schema}`);
    continue;
  }

  const failure = decoders[recording.schema](recording.body);

  if (Option.isNone(failure)) {
    console.log(`PASS  ${file}  ${recording.route} as ${recording.schema}`);
    continue;
  }

  failures++;
  console.log(`FAIL  ${file}  ${recording.route} as ${recording.schema}\n${failure.value.message}`);
}

console.log(`${files.length - failures} of ${files.length} recordings decode`);

process.exit(failures === 0 && files.length > 0 ? 0 : 1);
