'use strict';
import { commands, InputBoxOptions, TextEditor, Uri, window } from 'vscode';
import { GlyphChars } from '../constants';
import { Container } from '../container';
import { GitRepoSearchBy, GitService, GitUri } from '../git/gitService';
import { Logger } from '../logger';
import { Messages } from '../messages';
import { CommandQuickPickItem, CommitsQuickPick, ShowCommitSearchResultsInViewQuickPickItem } from '../quickpicks';
import { Iterables, Strings } from '../system';
import { SearchResultsCommitsNode } from '../views/nodes';
import {
    ActiveEditorCachedCommand,
    command,
    CommandContext,
    Commands,
    getCommandUri,
    getRepoPathOrActiveOrPrompt,
    isCommandViewContextWithRepo
} from './common';
import { ShowQuickCommitDetailsCommandArgs } from './showQuickCommitDetails';

const searchByRegex = /^([@~=:#])/;
const symbolToSearchByMap = new Map<string, GitRepoSearchBy>([
    ['@', GitRepoSearchBy.Author],
    ['~', GitRepoSearchBy.ChangedLines],
    ['=', GitRepoSearchBy.Changes],
    [':', GitRepoSearchBy.Files],
    ['#', GitRepoSearchBy.Sha]
]);

const searchByToSymbolMap = new Map<GitRepoSearchBy, string>([
    [GitRepoSearchBy.Author, '@'],
    [GitRepoSearchBy.ChangedLines, '~'],
    [GitRepoSearchBy.Changes, '='],
    [GitRepoSearchBy.Files, ':'],
    [GitRepoSearchBy.Sha, '#']
]);

export interface SearchCommitsCommandArgs {
    search?: string;
    searchBy?: GitRepoSearchBy;
    maxCount?: number;
    prefillOnly?: boolean;
    showInView?: boolean;

    goBackCommand?: CommandQuickPickItem;
    sha?: string;
    branch?: string;
    author?: string;
    since?: string;
    before?: Date;
    after?: Date;
    showMergeCommits?: boolean;
}

@command()
export class SearchCommitsCommand extends ActiveEditorCachedCommand {
    private _lastSearch: string | undefined;

    constructor() {
        super([Commands.SearchCommits, Commands.SearchCommitsInView]);
    }

    protected async preExecute(context: CommandContext, args: SearchCommitsCommandArgs = {}) {
        if (context.type === 'viewItem') {
            args = { ...args };
            args.showInView = true;

            if (context.node instanceof SearchResultsCommitsNode) {
                args.search = context.node.search;
                args.searchBy = context.node.searchBy;
                args.prefillOnly = true;
            }

            if (isCommandViewContextWithRepo(context)) {
                return this.execute(context.editor, context.node.uri, args);
            }
        }
        else if (context.command === Commands.SearchCommitsInView) {
            args = { ...args };
            args.showInView = true;
        }
        else {
            // TODO: Add a user setting (default to view?)
        }

        return this.execute(context.editor, context.uri, args);
    }

    async execute(editor?: TextEditor, uri?: Uri, args: SearchCommitsCommandArgs = {}) {
        uri = getCommandUri(uri, editor);

        const gitUri = uri && (await GitUri.fromUri(uri));

        const repoPath = await getRepoPathOrActiveOrPrompt(
            gitUri,
            editor,
            `Search for commits in which repository${GlyphChars.Ellipsis}`,
            args.goBackCommand
        );
        if (!repoPath) return undefined;

        args = { ...args };
        const originalArgs = { ...args };

        const searchByValuesMap = new Map<GitRepoSearchBy, string>();

        if (args.prefillOnly && args.search && args.searchBy) {
            args.search = `${searchByToSymbolMap.get(args.searchBy) || ''}${args.search}`;
            args.searchBy = undefined;
        }

        if (!args.search || args.searchBy == null) {
            let selection;
            if (!args.search) {
                if (args.searchBy != null) {
                    args.search = searchByToSymbolMap.get(args.searchBy);
                    selection = [1, 1];
                }
                /*else {
                    args.search = this._lastSearch;
                }*/
            }

            if (args.showInView) {
                await Container.searchView.show();
            }

            args.search = args.search || '';

            this._lastSearch = originalArgs.search = args.search;

            const match = searchByRegex.exec(args.search);
            if (match && match[1]) {
                const searchByValue = args.search.substring(args.search[1] === ' ' ? 2 : 1);
                const searchBy = symbolToSearchByMap.get(match[1]);
                if (searchBy) {
                    searchByValuesMap.set(searchBy, searchByValue);
                }
            }
            searchByValuesMap.set(GitRepoSearchBy.Message, args.search);
        }
        if (args.sha) {
            searchByValuesMap.set(GitRepoSearchBy.Sha, args.sha);
        }
        if (args.author && !searchByValuesMap.get(GitRepoSearchBy.Author)) {
            searchByValuesMap.set(GitRepoSearchBy.Author, args.author);
        }
        if (args.branch) {
            searchByValuesMap.set(GitRepoSearchBy.Branch, args.branch);
        }
        if (args.searchBy == null) {
            args.searchBy = GitRepoSearchBy.Message;
        }
        if (args.since && args.since !== '-1') {
            searchByValuesMap.set(GitRepoSearchBy.Since, args.since);
        }
        else {
            if (args.before) {
                searchByValuesMap.set(GitRepoSearchBy.Before, args.before.toString());
            }
            if (args.after) {
                searchByValuesMap.set(GitRepoSearchBy.After, args.after.toString());
            }
        }
        if (searchByValuesMap.size === 0) {
            searchByValuesMap.set(GitRepoSearchBy.Message, args.search);
        }
        const searchLabel: string | undefined = undefined;


        const progressCancellation = CommitsQuickPick.showProgress(searchLabel!);
        try {
            const log = await Container.git.getLogForSearch(repoPath, searchByValuesMap, {
                maxCount: args.maxCount,
                showMergeCommits: args.showMergeCommits
            });

            // clicking somewhere when commits are being loaded
            // cancels the progress
            // disabled cancellation check
            // if (progressCancellation.token.isCancellationRequested) return undefined;

            const goBackCommand: CommandQuickPickItem | undefined =
                args.goBackCommand ||
                new CommandQuickPickItem(
                    {
                        label: `go back ${GlyphChars.ArrowBack}`,
                        description: `${Strings.pad(GlyphChars.Dash, 2, 3)} to commit search`
                    },
                    Commands.SearchCommits,
                    [uri, originalArgs]
                );

                const pick = await CommitsQuickPick.show(log, searchLabel!, progressCancellation, {
                    goBackCommand: goBackCommand,
                    showAllCommand:
                        log !== undefined && log.truncated
                            ? new CommandQuickPickItem(
                                  {
                                      label: `$(sync) Show All Commits`,
                                      description: `${Strings.pad(GlyphChars.Dash, 2, 3)} this may take a while`
                                  },
                                  Commands.SearchCommits,
                                  [uri, { ...args, maxCount: 0, goBackCommand: goBackCommand }]
                              )
                            : undefined,
                    showInViewCommand:
                        log !== undefined
                            ? new ShowCommitSearchResultsInViewQuickPickItem(args.search, args.searchBy, log, {
                                  label: searchLabel!
                              })
                            : undefined
                });
                if (pick === undefined) return undefined;

                if (pick instanceof CommandQuickPickItem) return pick.execute();

                return undefined;
        }
        catch (ex) {
            Logger.error(ex, 'ShowCommitSearchCommand');
            return Messages.showGenericErrorMessage('Unable to find commits');
        }
        finally {
            progressCancellation.cancel();
        }
    }
}
