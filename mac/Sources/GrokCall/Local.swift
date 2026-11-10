import SwiftUI

/// `@State` without the SwiftUI macro (its plugin ships only with full Xcode, not the command line tools).
/// SwiftUI finds the `State` inside through `DynamicProperty`, so it behaves exactly like `@State`.
@propertyWrapper
struct Local<Value>: DynamicProperty {
    private let state: State<Value>
    init(wrappedValue: Value) { state = State(initialValue: wrappedValue) }
    var wrappedValue: Value {
        get { state.wrappedValue }
        nonmutating set { state.wrappedValue = newValue }
    }
    var projectedValue: Binding<Value> { state.projectedValue }
}
