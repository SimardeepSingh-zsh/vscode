/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from 'vs/base/browser/dom';
import { Orientation, Sash } from 'vs/base/browser/ui/sash/sash';
import { CancellationToken } from 'vs/base/common/cancellation';
import { Emitter } from 'vs/base/common/event';
import { Disposable, DisposableStore } from 'vs/base/common/lifecycle';
import { IContextKeyService } from 'vs/platform/contextkey/common/contextkey';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { ServiceCollection } from 'vs/platform/instantiation/common/serviceCollection';
import { IQuickInputService, IQuickWidget } from 'vs/platform/quickinput/common/quickInput';
import { inputBackground, quickInputBackground, quickInputForeground } from 'vs/platform/theme/common/colorRegistry';
import { IChatWidgetService, IQuickChatService } from 'vs/workbench/contrib/chat/browser/chat';
import { IChatViewOptions } from 'vs/workbench/contrib/chat/browser/chatViewPane';
import { ChatWidget } from 'vs/workbench/contrib/chat/browser/chatWidget';
import { ChatModel } from 'vs/workbench/contrib/chat/common/chatModel';
import { IChatService } from 'vs/workbench/contrib/chat/common/chatService';

export class QuickChatService extends Disposable implements IQuickChatService {
	readonly _serviceBrand: undefined;

	private readonly _onDidClose = this._register(new Emitter<void>());
	readonly onDidClose = this._onDidClose.event;

	private _input: IQuickWidget | undefined;
	// TODO@TylerLeonhardt: support multiple chat providers eventually
	private _currentChat: QuickChat | undefined;
	private _container: HTMLElement | undefined;

	constructor(
		@IQuickInputService private readonly quickInputService: IQuickInputService,
		@IChatService private readonly chatService: IChatService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) {
		super();
	}

	get enabled(): boolean {
		return this.chatService.getProviderInfos().length > 0;
	}

	get focused(): boolean {
		const widget = this._input?.widget as HTMLElement | undefined;
		if (!widget) {
			return false;
		}
		return dom.isAncestor(document.activeElement, widget);
	}

	toggle(providerId?: string, query?: string | undefined): void {
		// If the input is already shown, hide it. This provides a toggle behavior of the quick pick
		if (this.focused) {
			this.close();
		} else {
			this.open(providerId, query);
		}
	}
	open(providerId?: string, query?: string | undefined): void {
		if (this.focused) {
			return this.focus();
		}

		// Check if any providers are available. If not, show nothing
		// This shouldn't be needed because of the precondition, but just in case
		const providerInfo = providerId
			? this.chatService.getProviderInfos().find(info => info.id === providerId)
			: this.chatService.getProviderInfos()[0];
		if (!providerInfo) {
			return;
		}

		const disposableStore = new DisposableStore();

		this._input = this.quickInputService.createQuickWidget();
		this._input.contextKey = 'chatInputVisible';
		this._input.ignoreFocusOut = true;
		disposableStore.add(this._input);

		this._container ??= dom.$('.interactive-session');
		this._input.widget = this._container;

		this._input.show();
		if (!this._currentChat) {
			this._currentChat = this.instantiationService.createInstance(QuickChat, {
				providerId: providerInfo.id,
			});

			// show needs to come after the quickpick is shown
			this._currentChat.render(this._container);
		}

		disposableStore.add(this._input.onDidHide(() => {
			disposableStore.dispose();
			this._input = undefined;
			this._onDidClose.fire();
		}));

		this._currentChat.focus();

		if (query) {
			this._currentChat.setValue(query);
			this._currentChat.acceptInput();
		}
	}
	focus(): void {
		this._currentChat?.focus();
	}
	close(): void {
		this._input?.dispose();
		this._input = undefined;
	}
	async openInChatView(): Promise<void> {
		await this._currentChat?.openChatView();
		this.close();
	}
}

class QuickChat extends Disposable {
	// TODO@TylerLeonhardt: be responsive to window size
	static DEFAULT_MIN_HEIGHT = 200;
	static DEFAULT_MAX_HEIGHT = 900;

	private widget!: ChatWidget;
	private sash!: Sash;
	private model: ChatModel | undefined;
	private _currentQuery: string | undefined;

	constructor(
		private readonly _options: IChatViewOptions,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
		@IChatService private readonly chatService: IChatService,
		@IChatWidgetService private readonly _chatWidgetService: IChatWidgetService
	) {
		super();
	}

	clear() {
		this.model?.dispose();
		this.model = undefined;
		this.updateModel();
		this.widget.inputEditor.setValue('');
	}

	focus(): void {
		if (this.widget) {
			this.widget.focusInput();
			const value = this.widget.inputEditor.getValue();
			if (value) {
				this.widget.inputEditor.setSelection({
					startLineNumber: 1,
					startColumn: 1,
					endLineNumber: 1,
					endColumn: value.length + 1
				});
			}
		}
	}

	render(parent: HTMLElement): void {
		if (this.widget) {
			throw new Error('Cannot render quick chat twice');
		}
		const scopedInstantiationService = this.instantiationService.createChild(
			new ServiceCollection([
				IContextKeyService,
				this._register(this.contextKeyService.createScoped(parent))
			])
		);
		this.widget = this._register(
			scopedInstantiationService.createInstance(
				ChatWidget,
				{ resource: true, renderInputOnTop: true, renderStyle: 'compact' },
				{
					listForeground: quickInputForeground,
					listBackground: quickInputBackground,
					inputEditorBackground: inputBackground,
					resultEditorBackground: quickInputBackground
				}));
		this.widget.render(parent);
		this.widget.setVisible(true);
		this.widget.setDynamicChatTreeItemLayout(2, QuickChat.DEFAULT_MAX_HEIGHT);
		this.updateModel();
		this.sash = this._register(new Sash(parent, { getHorizontalSashTop: () => parent.offsetHeight }, { orientation: Orientation.HORIZONTAL }));
		this.registerListeners(parent);
	}

	private registerListeners(parent: HTMLElement): void {
		this._register(this.widget.inputEditor.onDidChangeModelContent((e) => {
			this._currentQuery = this.widget.inputEditor.getValue();
		}));
		this._register(this.widget.onDidClear(() => this.clear()));
		this._register(this.widget.onDidChangeHeight((e) => this.sash.layout()));
		const width = parent.offsetWidth;
		this._register(this.sash.onDidChange((e) => {
			if (e.currentY < QuickChat.DEFAULT_MIN_HEIGHT || e.currentY > QuickChat.DEFAULT_MAX_HEIGHT) {
				return;
			}
			this.widget.layout(e.currentY, width);
			this.sash.layout();
		}));
	}

	async acceptInput(): Promise<void> {
		return this.widget.acceptInput();
	}

	async openChatView(): Promise<void> {
		const widget = await this._chatWidgetService.revealViewForProvider(this._options.providerId);
		if (!widget?.viewModel || !this.model) {
			return;
		}

		for (const request of this.model.getRequests()) {
			if (request.response?.response.value || request.response?.errorDetails) {
				this.chatService.addCompleteRequest(widget.viewModel.sessionId,
					request.message as string,
					{
						message: request.response.response.value,
						errorDetails: request.response.errorDetails,
						followups: request.response.followups
					});
			} else if (request.message) {

			}
		}

		const value = this.widget.inputEditor.getValue();
		if (value) {
			widget.inputEditor.setValue(value);
		}
		widget.focusInput();
	}

	setValue(value: string): void {
		this.widget.inputEditor.setValue(value);
		this.focus();
	}

	private updateModel(): void {
		this.model ??= this.chatService.startSession(this._options.providerId, CancellationToken.None);
		if (!this.model) {
			throw new Error('Could not start chat session');
		}

		this.widget.setModel(this.model, { inputValue: this._currentQuery });
	}
}
